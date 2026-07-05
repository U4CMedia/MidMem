# How knowledge is CAPTURED into MidMem (OpenClaw · Hermes · Claude Code)

*Companion to [INTEGRATION-MODES.md](INTEGRATION-MODES.md) (which covers how the core is **reached**).
This doc covers how knowledge actually **gets in** across the three agent surfaces, what is reliable,
and what is not. Grounded against the running stacks 2026-07-05 (OD-CYCLE-005/006/007) — verified
behavior, not aspiration.*

## The one store, one tool surface

Both OpenClaw and Hermes reach the same `state.db` through the MCP server (`bin/mcp-server.mjs`). The
capture-relevant tools an agent can call: **`ingest`** (compile a source file → tiered/embedded/graphed
entry), **`remember`** (store a distilled entry), **`record_work`** (a tiered work-event:
`task_attempt`/`source_used`/`dead_end`/`correction`/`artifact`/`decision`). All are agent-invoked; none
fire on their own.

## Two capture layers — only one is load-bearing

| Layer | Mechanism | Status | Weight |
|---|---|---|---|
| **Explicit recording** | agent calls `ingest`/`remember`/`record_work`; Claude Code `openduck-record` skill → `midmem remember` + CHANGELOG, **enforced by a Stop guard hook** | **works, enforced** | ✅ the one that matters |
| **Automatic per-turn capture** | a hook/patch fires a `record_work` for every agent turn | mixed (see below) | ⚙️ completeness bonus |

The **important** captures (decisions, lessons, RCAs, ingested docs) flow through the **explicit** layer.
Automatic per-turn capture is a completeness nicety — valuable, but it fought both stacks' internals
before landing (see the case studies). Don't rely on passive conversation being remembered.

## Capture channels by surface (verified)

| Surface | Channel | Reliability | Latency |
|---|---|---|---|
| **Any** | `ingest` (stage arbitrary content to an allowed source root, then compile) | High (user-driven) | immediate |
| **Any** | `remember` / `record_work` on request | discretionary | immediate |
| **OpenClaw / Hermes** | write a deliverable to a bridged folder (`workspace/memory`, `hermes/memories`, vault `OpenClaw/`·`Hermes/`) → daily `maintain` bridge | high *for docs* | daily |
| **Hermes** | **automatic per-turn** work-event in `turn_finalizer.finalize_turn` (OD-CYCLE-007) | **live — fires every ACP/kanban turn** | immediate |
| **OpenClaw** | automatic per-turn via `message:sent`/managed hook | **does NOT work** (see OD-CYCLE-006) | — |
| **Claude Code** | `openduck-record` skill → `midmem remember`, Stop-guard-enforced | high, enforced | immediate |

## Case studies — what worked, what didn't, and why (the load-bearing findings)

### Hermes automatic capture — WORKS (OD-CYCLE-007, live)
A fail-open `record_work` in **Hermes core** `agent/turn_finalizer.finalize_turn` fires on **every**
turn — including tool-ending ACP/kanban worker turns. See
[`integrations/hermes-workcapture/`](../integrations/hermes-workcapture/).
- **Why a plugin didn't work:** the Hermes `post_llm_call` plugin (OD-CYCLE-005) is **never discovered
  in the ACP-spawned worker process** (`run_agent.py` doesn't call `discover_plugins()`), so its hook
  handler is never registered — `invoke_hook("post_llm_call")` finds nothing. The core call bypasses
  plugin discovery entirely. Proven live: a real dispatcher-spawned kanban worker turn produced a
  `scope=hermes` work-event where the plugin produced none.
- **Kind is derived from a STRUCTURED tool-error signal** (a `role:tool` result with truthy
  `error`/`success:false`/`is_error`), *not* an error word in prose — otherwise benign turns mis-derive
  `dead_end` and get tier-demoted.

### OpenClaw automatic capture — DOES NOT WORK (OD-CYCLE-006, retired)
Neither a managed `message:sent` internal hook nor a typed `message_sent` plugin captures OpenClaw
**agent replies**. Root cause: OpenClaw only dispatches the internal `message:sent` hook when
`sessionKeyForInternalHooks` is set, which is empty on the agent `message`-tool reply path; and on a
confirmed 1156-char reply, a correctly-loaded plugin still produced zero work-events. The correct hook
would be an **agent-lifecycle** event (`agent_end`), not a delivery event — not built. See
[`integrations/openclaw-workcapture/`](../integrations/openclaw-workcapture/) (reference/retired).
OpenClaw is the daily-driver, not the capture-critical path; its content reaches midmem via the daily
doc bridge for anything written to a bridged folder.

### Claude Code — explicit + enforced (OD-CYCLE-004)
The `openduck-record` skill routes lessons to `midmem remember` and a CHANGELOG, and a `PostToolUse` +
`Stop` guard hook **blocks a turn from ending** while a config/service/install change is unrecorded.
This is the most reliable capture path on the host and the model for "harness-guaranteed" recording.

## Practical guidance — to ENSURE something is captured
1. **`/ingest <thing>`** — the immediate, durable, user-driven lever.
2. Ask the agent to **`remember`/`record_work`** a distilled fact (`scope=shared` for the commons).
3. For Hermes output: it is auto-captured per turn now (OD-CYCLE-007); for durable docs, write to the
   vault `Hermes/` folder (bridged).
4. Don't rely on OpenClaw conversation being auto-remembered — `/ingest` or vault-write it.

*See [DEVELOPMENT-GUIDELINES.md](DEVELOPMENT-GUIDELINES.md) for the grounding + engineering rules these
case studies produced.*
