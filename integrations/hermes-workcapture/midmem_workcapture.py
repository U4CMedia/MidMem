"""midmem_workcapture — deterministic per-turn midmem capture in Hermes core.

Pure stdlib. Fail-open: the ENTIRE body of record_turn is wrapped in
try/except that swallows everything and never raises.

Public entry:
    record_turn(*, final_response, interrupted, messages, turn_id="",
                task_id="", session_id="", **_ignored) -> None
"""

import os
import re
import subprocess
import time
import sys
from collections import OrderedDict

# ---------------------------------------------------------------------------
# Safe env parsing — module-level int() must NEVER raise
# ---------------------------------------------------------------------------

def _safe_int(name: str, default: int) -> int:
    """Read an integer env var; return *default* on any failure."""
    try:
        return int(os.environ.get(name, str(default)))
    except (ValueError, TypeError, OSError):
        return default


# ---------------------------------------------------------------------------
# Environment constants (read once, with defaults)
# ---------------------------------------------------------------------------
_NODE = os.environ.get("MIDMEM_HERMES_CAPTURE_NODE", "node")
_HOOK = os.environ.get(
    "MIDMEM_HOOK_PATH",
    "/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs",
)
_DB = os.environ.get(
    "MIDMEM_DB_PATH",
    "/home/duck/.openclaw/workspace/midmem-kb-store/state.db",
)
_MAX_CHARS = _safe_int("MIDMEM_HERMES_CAPTURE_MAX_CHARS", 500)
_MIN_CHARS = _safe_int("MIDMEM_HERMES_CAPTURE_MIN_CHARS", 1)

# Valid kinds
_VALID_KINDS = frozenset(
    {"task_attempt", "source_used", "dead_end", "correction", "artifact", "decision"}
)

# ---------------------------------------------------------------------------
# Debounce state (module-level)
# ---------------------------------------------------------------------------
_debounce_cache: "OrderedDict[str, float]" = OrderedDict()
_DEBOUNCE_MAX = 256


def _reset_debounce() -> None:
    """Clear debounce state. Exported for tests."""
    _debounce_cache.clear()


# ---------------------------------------------------------------------------
# Helpers (exported for tests)
# ---------------------------------------------------------------------------

def collapse_ws(s: str) -> str:
    """Collapse runs of whitespace to single spaces, strip."""
    if not isinstance(s, str):
        return ""
    return re.sub(r"\s+", " ", s).strip()


_ARTIFACT_PAT = re.compile(r"/[^\s]{3,}|https?://\S+")
# Roles that denote a tool RESULT message (case-insensitive match on role/type).
_TOOL_ROLES = {"tool", "toolresult", "tool_result", "tool-result", "function", "observation"}
# A structured error shape inside a tool result string (JSON-ish), not prose.
# `"error"` must have a TRUTHY value — a non-empty string, an object, or an
# array. `"error": false` / `null` / `""` / `0` mean NO error and MUST NOT match
# (the `[^n]` hack previously matched the `f` of `false` → false positives).
_STRUCT_ERR_PAT = re.compile(r'"error"\s*:\s*("[^"]|\{\s*"|\[\s*[^\]\s])|"success"\s*:\s*false', re.IGNORECASE)


def _has_tool_error(messages) -> bool:
    """Deterministic: True only if a TOOL RESULT signals a real error.

    Uses structured signals (message ``is_error`` flag, or a tool-result body
    that is/serialises to ``{"error": ...}`` / ``{"success": false}`` / starts
    with ``Error``) — NOT an error word appearing in normal assistant prose.
    Never raises.
    """
    if not isinstance(messages, (list, tuple)):
        return False
    for msg in messages:
        try:
            if not isinstance(msg, dict):
                continue
            # message-level error flags (various dialects)
            if msg.get("is_error") or msg.get("isError") or msg.get("error") is True:
                return True
            role = str(msg.get("role", "") or msg.get("type", "")).lower()
            if role not in _TOOL_ROLES:
                continue
            content = msg.get("content", "")
            texts = []
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, (list, tuple)):
                for part in content:
                    if isinstance(part, str):
                        texts.append(part)
                    elif isinstance(part, dict):
                        t = part.get("text") or part.get("content")
                        if isinstance(t, str):
                            texts.append(t)
                    # structured part flag
                    if isinstance(part, dict) and (part.get("is_error") or part.get("isError")):
                        return True
            for t in texts:
                ts = t.strip()
                # Prefer authoritative JSON parse (checks the VALUE's truthiness).
                if ts.startswith("{") or ts.startswith("["):
                    try:
                        data = json.loads(ts)
                        if isinstance(data, dict) and (data.get("error") or data.get("success") is False):
                            return True
                        # parsed but not an error shape -> this result is clean
                        continue
                    except Exception:
                        pass  # not valid JSON; fall through to text heuristics
                # Non-JSON tool results: genuine error prefixes only (not prose).
                if ts.startswith("Error") or ts.startswith("Traceback"):
                    return True
                if ("error" in ts.lower() or "success" in ts.lower()) and _STRUCT_ERR_PAT.search(ts):
                    return True
        except Exception:
            continue
    return False


def derive_kind(fr: str, tool_txt: str, tool_error: bool = False) -> str:
    """Deterministic kind derivation.

    First match wins:
      real tool error -> dead_end   (structured signal only, not prose)
      path/url        -> artifact
      else if fr      -> decision
      else (tool activity only) -> task_attempt
    """
    if not isinstance(fr, str):
        fr = ""
    if not isinstance(tool_txt, str):
        tool_txt = ""
    if tool_error:
        return "dead_end"
    if _ARTIFACT_PAT.search(fr + " " + tool_txt):
        return "artifact"
    if fr.strip():
        return "decision"
    return "task_attempt"


# ---------------------------------------------------------------------------
# Core: record_turn
# ---------------------------------------------------------------------------

def record_turn(*, final_response, interrupted, messages, turn_id="",
                task_id="", session_id="", **_ignored) -> None:
    """Record a Hermes turn as a midmem work-event.

    Fail-open: never raises.
    """
    try:
        # 1. Kill switch
        if os.environ.get("MIDMEM_HERMES_CAPTURE_DISABLED"):
            return

        # 2. Gather signal
        fr = final_response if isinstance(final_response, str) else ""
        tool_txt = _scan_messages(messages)

        # 3. Skip truly-empty turns
        combined = fr + " " + tool_txt
        if not fr.strip() and not tool_txt.strip():
            return

        # 4. Salience floor
        if len((fr or tool_txt).strip()) < _MIN_CHARS:
            return

        # 5. Debounce
        debounce_s = _safe_int("MIDMEM_HERMES_CAPTURE_DEBOUNCE_S", 0)
        if debounce_s > 0:
            key = task_id or session_id
            now_ms = time.time() * 1000
            if key in _debounce_cache:
                last_ms = _debounce_cache[key]
                if (now_ms - last_ms) < debounce_s * 1000:
                    return
            _debounce_cache[key] = now_ms
            if len(_debounce_cache) > _DEBOUNCE_MAX:
                _debounce_cache.popitem(last=False)

        # 6. Deterministic kind (dead_end only on a STRUCTURED tool error)
        kind = derive_kind(fr, tool_txt, _has_tool_error(messages))
        if kind not in _VALID_KINDS:
            kind = "task_attempt"

        # 7. Fields
        task = task_id or session_id or "hermes-turn"
        content = collapse_ws(fr or tool_txt)[:_MAX_CHARS]
        source = "hermes:acp:" + (session_id or "sess") + ":turn:" + (turn_id or "n/a")

        # 8. Emit — detached child, never awaited
        _emit(kind, task, content, source)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _scan_messages(messages):
    """Scan messages list into a tool_txt string. Defensive — never raise."""
    if not isinstance(messages, (list, tuple)):
        return ""
    parts = []
    for msg in messages:
        try:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "")
            content = msg.get("content", "")
            # content may be str or list-of-parts
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, (list, tuple)):
                for part in content:
                    if isinstance(part, str):
                        parts.append(part)
                    elif isinstance(part, dict):
                        text = part.get("text", "")
                        if isinstance(text, str):
                            parts.append(text)
            # tool_calls
            if role == "assistant":
                tc = msg.get("tool_calls", [])
                if isinstance(tc, list):
                    for call in tc:
                        if isinstance(call, dict):
                            name = call.get("name", "")
                            if isinstance(name, str):
                                parts.append(f"tool:{name}")
        except Exception:
            continue
    return " ".join(parts)


def _emit(kind, task, content, source):
    """Spawn detached subprocess. Wrapped in its own try/except.

    NODE/HOOK/DB are read at CALL time (not import time) so a runtime
    ``MIDMEM_DB_PATH`` override applies — this keeps tests isolated to a
    throwaway db (no prod pollution) and lets operators redirect emits.
    """
    try:
        node = os.environ.get("MIDMEM_HERMES_CAPTURE_NODE", "node")
        hook = os.environ.get(
            "MIDMEM_HOOK_PATH",
            "/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs",
        )
        db = os.environ.get(
            "MIDMEM_DB_PATH",
            "/home/duck/.openclaw/workspace/midmem-kb-store/state.db",
        )
        env = {
            **os.environ,
            "MIDMEM_DB_PATH": db,
            "MIDMEM_AGENT_SCOPE": "hermes",
            "MIDMEM_LLM_ENABLED": "0",
        }
        subprocess.Popen(
            [node, hook, "post", "--kind", kind, "--scope", "hermes",
             "--task", task, "--content", content, "--source", source],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except Exception:
        pass
