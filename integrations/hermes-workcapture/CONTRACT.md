# CONTRACT — OD-CYCLE-007 Option A: deterministic per-turn midmem capture in Hermes core

**Frozen interface.** Builder (qwen) implements to this; QA (gpt-5.5) diffs against these clauses.
Planner owns changes + the live-core cutover. Goal: **every Hermes ACP/kanban turn deterministically
registers a midmem work-event**, independent of plugin discovery and final-message shape — the fix the
spike validated (a core block fires where the plugin structurally cannot).

## CRITICAL build-safety rule
- **DO NOT edit anything under `~/.hermes/` or `/home/duck/.hermes/`.** The builder runs *on* Hermes;
  a syntax error there breaks every turn including your own worker. Build ONLY in the pilot repo dir
  `hermes-core/`. The planner copies the tested module into live core as a separate gated step.
- The deliverable is a **self-contained helper module** (unit-testable in isolation) + a **one-line
  patch spec** — NOT an in-place edit of `turn_finalizer.py`.

## Deliverables (this repo, new `hermes-core/` dir)
```
hermes-core/midmem_workcapture.py        # the helper: record_turn(...) — pure-stdlib, fail-open
hermes-core/test_midmem_workcapture.py   # unittest/pytest-runnable; no network, no ~/.hermes import
hermes-core/PATCH.md                     # exact one-line insertion point + call for finalize_turn
```

## `midmem_workcapture.py` — the helper

Pure Python stdlib only (no third-party imports; it will live in Hermes core). Public entry:

```python
def record_turn(*, final_response, interrupted, messages, turn_id="",
                task_id="", session_id="", **_ignored) -> None
```

**The ENTIRE body is wrapped in try/except that swallows everything and returns** — a capture error
must NEVER raise into `finalize_turn` (that would break the Hermes turn). Order:

1. **Kill switch:** if `MIDMEM_HERMES_CAPTURE_DISABLED` is truthy (`1/true/yes/on`) → return.
2. **Gather signal:** `fr = final_response if isinstance(final_response, str) else ""`; scan `messages`
   (list of dicts; `content` may be str or list-of-parts) into `tool_txt` (concatenated text/tool
   names/results). Be defensive — any shape, never raise.
3. **Skip only truly-empty turns:** if `not fr.strip()` AND `not tool_txt.strip()` → return. (Anything
   with a final response OR any tool activity IS recorded — this is the "always register real turns"
   semantics, and it covers the tool-ending turns the plugin misses.)
4. **Salience floor (tunable, default LOW):** `MIDMEM_HERMES_CAPTURE_MIN_CHARS` default **`1`** — i.e.
   effectively always-on; operators can raise it. Compare against `len((fr or tool_txt).strip())`.
5. **Debounce (optional, default off):** `MIDMEM_HERMES_CAPTURE_DEBOUNCE_S` default `0` (no debounce).
   When >0, module-level `dict[key,last_ms]` keyed on `task_id or session_id`; skip if within window;
   cap dict at 256 (evict oldest). Update only on an actual emit.
6. **Deterministic kind** (first match; from `fr + " " + tool_txt`), must be in
   `{task_attempt, source_used, dead_end, correction, artifact, decision}`:
   - error signature `\b(error|failed|exception|traceback|denied|not found)\b` (i) → `dead_end`
   - path/url `/[^\s]{3,}` or `https?://\S+` → `artifact`
   - else if `fr.strip()` → `decision`
   - else (tool activity only, no final text) → `task_attempt`
7. **Fields:** `task = task_id or session_id or "hermes-turn"`;
   `content = collapse_ws(fr or tool_txt)[:MAX_CHARS]` where `MAX_CHARS` = env
   `MIDMEM_HERMES_CAPTURE_MAX_CHARS` default `500`;
   `source = "hermes:acp:" + (session_id or "sess") + ":turn:" + (turn_id or "n/a")`.
8. **Emit — detached child, never awaited, never blocks the turn:**
   `subprocess.Popen(["node", HOOK, "post", "--kind", kind, "--scope", "hermes", "--task", task,
   "--content", content, "--source", source], env={**os.environ, "MIDMEM_DB_PATH": DB,
   "MIDMEM_AGENT_SCOPE": "hermes", "MIDMEM_LLM_ENABLED": "0"}, stdin=DEVNULL, stdout=DEVNULL,
   stderr=DEVNULL, close_fds=True)` wrapped in its own try/except.
   Env constants (read once, with these defaults): `NODE`=`MIDMEM_HERMES_CAPTURE_NODE` default `"node"`;
   `HOOK`=`MIDMEM_HOOK_PATH` default `/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs`;
   `DB`=`MIDMEM_DB_PATH` default `/home/duck/.openclaw/workspace/midmem-kb-store/state.db`.
   **`MIDMEM_LLM_ENABLED="0"` is non-negotiable** (58s embed on the hot path silently drops records).
9. Export pure helpers for tests: `derive_kind(text)`, `collapse_ws(s)`, `_reset_debounce()`.

## PATCH.md — the live-core insertion (planner applies; document it exactly)
Insert immediately before `return result` at the end of `finalize_turn`
(`agent/turn_finalizer.py`), as a fail-open single call:
```python
    try:
        from agent.midmem_workcapture import record_turn
        record_turn(final_response=final_response, interrupted=interrupted, messages=messages,
                    turn_id=turn_id, task_id=effective_task_id,
                    session_id=getattr(agent, "session_id", "") or "")
    except Exception:
        pass
    return result
```
(Variables `final_response`, `interrupted`, `messages`, `turn_id`, `effective_task_id`, `agent` are all
in scope there — verified.) The module file goes to `~/.hermes/hermes-agent/agent/midmem_workcapture.py`.

## Acceptance — `python3 -m pytest hermes-core/test_midmem_workcapture.py` (or `python3 -m unittest`) all green
Tests must **monkeypatch `subprocess.Popen`** to capture argv+env (no real spawn in unit tests), EXCEPT
the one real-integration test. Cover:
1. `record_turn` never raises — call with junk/None/empty/malformed `messages` (dict without content,
   content as int, etc.) → returns, no exception.
2. text-ending turn (`final_response` set, no tool err) → one Popen, `--kind decision`, `--scope hermes`.
3. tool-ending turn (`final_response=""`, `messages` has a tool result, no error) → one Popen,
   `--kind task_attempt` (THE case the plugin misses — must record).
4. dead_end: messages/response contain "Traceback … error" → `dead_end`.
5. artifact: a path `/home/duck/x.md` or URL present, no error words → `artifact`.
6. truly-empty turn (`final_response=""`, no tool text) → **no Popen**.
7. kill switch `MIDMEM_HERMES_CAPTURE_DISABLED=1` → no Popen.
8. emit env contract: captured env has `MIDMEM_AGENT_SCOPE=hermes` AND `MIDMEM_LLM_ENABLED=0`.
9. Popen forced to raise → `record_turn` still returns (fail-open), no propagation.
10. debounce: with `MIDMEM_HERMES_CAPTURE_DEBOUNCE_S=30`, two same-task turns → one Popen; after
    `_reset_debounce()` / different task → spawns again. (Default 0 = every turn spawns.)
11. real-midmem integration (skip if hook.mjs absent): fresh temp `MIDMEM_DB_PATH`, real `record_turn`
    on a tool-ending turn, wait, network-free `sqlite3` read → 1 row, `scope='hermes'`, distinctive token.

## Non-negotiables (QA auto-fail)
- `record_turn` can raise for ANY input → fail. Emit not detached / blocks the turn → fail. Missing
  `MIDMEM_LLM_ENABLED=0` → fail. Kind outside the valid set → fail. Third-party import in the module →
  fail. Tool-ending turn (test 3) not recorded → fail. Any edit under `~/.hermes/` → fail. Tautological
  tests (asserting on a patched internal instead of the captured Popen/real row) → fail.

## Cutover (planner only, after green QA)
Backup `agent/turn_finalizer.py` → copy `midmem_workcapture.py` to `~/.hermes/hermes-agent/agent/` →
apply the PATCH.md one-liner → `python3 -c "import ast; ast.parse(...)"` syntax gate on turn_finalizer →
run a REAL dispatcher-spawned kanban worker doing tool-work → confirm ≥1 `scope=hermes` work-event with
a `hermes:acp:…:turn:` source in prod per worker turn. Revert path: remove the one-liner + module.
No gateway restart needed (Hermes loads per ACP spawn). Add the module's test to the midmem smoke suite.
