# hermes-workcapture — automatic per-turn MidMem capture in Hermes (LIVE)

A fail-open `record_turn(...)` in Hermes core `agent/turn_finalizer.finalize_turn` that records **one
MidMem work-event per Hermes turn** — including tool-ending ACP/kanban worker turns. Deterministic
(kind from a structured tool-error signal, no LLM), never breaks or slows a turn. **Live in production
since 2026-07-05 (OD-CYCLE-007).**

## Why core, not a plugin
Hermes user plugins are **not discovered in the ACP-spawned worker process** (`run_agent.py` never calls
`discover_plugins()`), so a `post_llm_call` plugin's handler is never registered → `invoke_hook` finds
nothing. A core call in `finalize_turn` fires regardless of plugin discovery and final-message shape.
Proven live: a real dispatcher-spawned kanban worker turn produced a `scope=hermes` work-event where the
plugin produced none.

## Files
- `midmem_workcapture.py` — the module (pure stdlib, fail-open). Public: `record_turn(...)`; helpers
  `derive_kind`, `_has_tool_error`, `collapse_ws`, `_reset_debounce`.
- `test_midmem_workcapture.py` — 39 tests: `python3 -m unittest test_midmem_workcapture`. Suite-wide
  temp-`MIDMEM_DB_PATH` guard (zero prod pollution) + one real `hook.mjs`→sqlite integration test.
- `PATCH.md` — the exact one-line insertion for `finalize_turn`.
- `CONTRACT.md` — the frozen build contract.

## Install (into a Hermes checkout)
1. Copy `midmem_workcapture.py` → `<hermes>/agent/midmem_workcapture.py`.
2. Apply the `PATCH.md` one-liner immediately before `return result` in
   `<hermes>/agent/turn_finalizer.py` (fail-open `try: … record_turn(...) except Exception: pass`).
3. `python3 -c "import ast; ast.parse(open('<hermes>/agent/turn_finalizer.py').read())"` — syntax gate.
4. No gateway restart — Hermes loads per ACP spawn. **Verify on a real dispatcher-spawned worker doing
   tool-work**: confirm a `scope=hermes` work-event with a `hermes:acp:…:turn:` source lands in prod.

## Behavior (env-tunable, `MIDMEM_HERMES_CAPTURE_*`)
- Records every non-empty turn (`MIN_CHARS` default 1). Kind: **`dead_end`** only on a structured tool
  error (`role:tool` result with truthy `error`/`success:false`/`is_error`); **`artifact`** on a
  path/URL; **`decision`** with a final text response; **`task_attempt`** otherwise.
- `MIDMEM_HERMES_CAPTURE_DISABLED=1` kill switch; `…_DEBOUNCE_S` (default 0); `…_MIN_CHARS`, `…_MAX_CHARS`.
- Emit sets `MIDMEM_AGENT_SCOPE=hermes` + `MIDMEM_LLM_ENABLED=0`; reads `MIDMEM_DB_PATH`/hook/node at
  **call time**.

## Maintenance
Hermes-core edit → after any Hermes upgrade, re-copy the module, re-apply the one-liner, re-run the
tests. Keep a backup of the pre-patch `turn_finalizer.py`.
