# MidMem integrations — packaged, reusable capture code

Reusable code for wiring **automatic per-turn work-capture** into an agent stack, with honest status
from real deployment (OD-CYCLE-005/006/007, 2026-07-05). See
[`docs/STACK-CAPTURE.md`](../docs/STACK-CAPTURE.md) for the capture model and
[`docs/DEVELOPMENT-GUIDELINES.md`](../docs/DEVELOPMENT-GUIDELINES.md) for the engineering rules these
built on.

All of these emit a `record_work` work-event by spawning `packages/core/bin/hook.mjs post` detached,
with `MIDMEM_AGENT_SCOPE=<stack>` and **`MIDMEM_LLM_ENABLED=0`** (fast + durable; vector backfills on the
daily `maintain`). All are fail-open — a capture error must never break the host turn.

| Package | Stack | Status | Mechanism |
|---|---|---|---|
| [`hermes-workcapture/`](hermes-workcapture/) | Hermes | ✅ **LIVE** | fail-open `record_turn` in core `turn_finalizer.finalize_turn` |
| [`openclaw-workcapture/`](openclaw-workcapture/) | OpenClaw | ⚠️ **retired / reference** | typed `message_sent` plugin — loads but never fires on agent replies |

**Key lesson (why one works, one doesn't):** guaranteed per-turn capture must live at an **unconditional
core seam**, not a discretionary plugin hook. Hermes plugins aren't discovered in the ACP worker
process; OpenClaw doesn't dispatch `message:sent` for agent replies. The core-seam approach bypasses
both. If you build capture for a new stack, find the always-run turn-finalization point and put a
fail-open emit there — and **verify it FIRES on a real turn**, don't trust "loaded/ready".
