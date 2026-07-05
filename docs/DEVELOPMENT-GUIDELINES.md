# MidMem Development & Research Guidelines

*The discipline for building on / integrating MidMem. Pairs the research foundations (see
[RESEARCH.md](../RESEARCH.md)) with the hard-won operational rules from real integration work
(OD-CYCLE-004…007, 2026-07-05). Every rule here is grounded in an actual incident, not theory.*

## 1. Grounding (DELEGATE-52) — the load-bearing discipline

Full research entry in [RESEARCH.md](../RESEARCH.md) (§ DELEGATE-52). The operating rules:

- **Verify against the actual code/schema/runtime, not docs or a model's summary.** Docs lied twice in
  one day: OpenClaw's own hooks doc sanctioned `message:sent` for exactly the use case that turned out
  never to fire on agent replies. Read the dist, run the probe, inspect the row.
- **Never trust an LLM to verify its own faithfulness.** Ingest runs the deterministic grounding check
  (`src/grounding.mjs`) *before* persisting extracted concepts/claims. Categorization, work-event
  recording, contradiction detection, kind derivation — all deterministic, no LLM in the path.
- **Prefer a structured signal over a fuzzy one.** Deriving a work-event `kind=dead_end` from an error
  *word in prose* mis-flagged benign turns ("no errors found" → dead_end). The fix: derive `dead_end`
  only from a **structured tool-error** (`role:tool` result with truthy `error`/`success:false`). A
  regex over prose is a fuzzy signal; a typed result field is a structured one — use the latter.
- **Interaction length is the dominant degradation variable.** Small, single-purpose units with a
  verifying gate beat one long editing session. Split work; don't extend a long context.

## 2. Verify a hook FIRES — "loaded/ready/registered" is not "fires"

The most expensive lesson of OD-CYCLE-005/006. Three different capture hooks (Hermes plugin, OpenClaw
managed hook, OpenClaw plugin) all **loaded, showed ready, registered correctly** — and **none fired**
in production. A green test suite and a `✓ ready` status prove nothing about live dispatch.

- **Confirm capture end-to-end with a real event**, then read the actual `state.db` row. For OpenClaw,
  `openclaw plugins inspect <id> --runtime` (Status loaded + Typed hooks) is necessary but *not*
  sufficient — a plugin can load and register a `message_sent` hook that the delivery path never calls.
- **Know your dispatch gate.** OpenClaw gates the internal `message:sent` hook on
  `sessionKeyForInternalHooks` (empty on agent replies); Hermes gates `post_llm_call` on a non-empty
  `final_response` AND on the plugin being discovered in the process (`run_agent.py` doesn't discover).
  If capture must be *guaranteed*, put it at an unconditional core seam (Hermes `finalize_turn`), not a
  discretionary plugin — the harness-guaranteed pattern (cf. the Claude Code Stop guard).

## 3. Emitting to `state.db` from an integration — isolation & the DB path

- **Read `MIDMEM_DB_PATH` (and the hook/node path) at CALL time, not import time.** A module that
  captures its DB path at import can never be redirected by a test or a runtime override — every
  un-isolated emit then silently writes to the **production** `state.db`. This polluted prod twice
  (OpenClaw handler tests, Hermes core tests: 30+ junk rows) before it was caught.
- **A green test suite is not proof of isolation.** Point `MIDMEM_DB_PATH` at a throwaway temp db
  **suite-wide** (a `setUpModule` guard) so any un-mocked emit can't touch prod, and **assert the prod
  entry count is unchanged across the run**. Mock the subprocess spawn in unit tests; use a real spawn
  only in one temp-db integration test.
- **`MIDMEM_LLM_ENABLED=0` on the hot path is non-negotiable.** A `hook.mjs post` that embeds via the
  network model takes ~58s cold and silently drops the record under a per-turn timeout. Disable
  embedding on emit; the daily `maintain` backfills the vector. (FTS/trigram index immediately, so the
  entry is searchable at once.)
- **Emit fail-open, detached, never awaited.** A capture error must never break or slow the host turn.

## 4. Delegated builds (three-tier: frontier plans · local model builds · frontier QA)

- **A green build is not a passing build — QA against the CONTRACT.** gpt-5.5 review caught tautological
  tests, a skipped integration test dressed up as "hook.mjs hangs" (it was the 58s embed), and contract
  drift that the builder's own green suite hid. The planner's final gate then caught prod pollution QA
  missed. Layer the checks; each catches a different class.
- **Never let a builder that runs on the target edit the target.** The Hermes worker runs *on* Hermes; a
  syntax slip in `turn_finalizer.py` would break every turn including the builder's own. Build the
  module + a one-line patch in an isolated repo; the planner applies it to live core with backup →
  syntax-gate → verify → revert path.
- **A worker's "it's just infrastructure" gets reproduced, never accepted.** A fix card once dismissed
  real test failures as "infrastructure"; reproduced on a quiet workspace, they were genuine bugs.

## 5. MidMem core discipline (unchanged, restated)

Keep it **pure-core + modular** (all capability in `packages/core`, one `state.db`, reached only via
CLI / MCP / hook seam — nothing in core knows about OpenClaw or Hermes). `state.db` is source of truth;
the vault projection is deterministic and regenerable (never canonical, never hand-edited).
Lifecycle/promotion is earned by usage/feedback, never LLM judgment. **The smoke suite is the contract**
(`node packages/core/test/smoke.mjs` must stay green); add a test for every capability. Anything that
ingests inside `maintain()` must be re-entrancy-guarded.

---
*Cross-refs: [STACK-CAPTURE.md](STACK-CAPTURE.md) (what each surface captures), [RESEARCH.md](../RESEARCH.md)
(paper→decision record), [`integrations/`](../integrations/) (packaged reusable code + status).*
