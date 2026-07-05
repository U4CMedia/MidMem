# openclaw-workcapture — typed `message_sent` plugin (RETIRED / reference)

An OpenClaw typed plugin registering `api.on("message_sent", …)` to record a MidMem work-event per
delivered agent reply. **Kept for reference — it does NOT capture OpenClaw agent replies** and is not
deployed. (OD-CYCLE-006.)

## Why it doesn't work
- OpenClaw dispatches the **internal** `message:sent` hook only when `sessionKeyForInternalHooks` is
  set — **empty on the agent `message`-tool reply path** — so a managed `message:sent` hook never fires
  for ordinary agent replies (verified: handler never invoked across 3+ real replies).
- The **typed plugin** version *loads and registers* correctly (`openclaw plugins inspect
  midmem-workcapture --runtime` → `Status: loaded`, `Typed hooks: message_sent`) but still produced
  **zero** work-events on a confirmed **1156-char** agent reply → `message:sent` isn't emitted for the
  agent tool-reply path in this deployment.
- The correct capture point is an **agent-lifecycle** hook (`agent_end` — "observe final messages,
  success, duration"), not a delivery event. **Not built** (OpenClaw is the daily-driver, not the
  capture-critical path; its content reaches midmem via the daily doc bridge).

## Reusable bits (if you revisit with `agent_end`)
- `index.ts` — `definePluginEntry` entry + `api.on(...)`; reads the plugin event's **top-level**
  `content`/`sessionKey` (NOT `event.context.content` — that shape difference is a real trap).
- `emit.ts` — deterministic `deriveKind` + detached `hook.mjs post` spawn (`MIDMEM_LLM_ENABLED=0`,
  `MIDMEM_AGENT_SCOPE=openclaw`), debounce.
- `openclaw.plugin.json` + `package.json` — a **hook-only** plugin needs `activation.onStartup:true`
  and `package.json` `openclaw.extensions:["./index.ts"]`; local TS installs via `openclaw plugins
  install --link` (a packaged install demands compiled `dist/*.js`). Confirm load with `plugins inspect
  … --runtime` before trusting it.
- `openclaw-plugin.test.mjs` — `node --test` suite (behavioral; captured-argv + real sqlite integration).

## Lesson
"Loaded/ready/registered" ≠ "fires". Verify capture with a real delivered reply and read the row.
For guaranteed per-turn capture, prefer an unconditional core seam over a delivery-event hook.
