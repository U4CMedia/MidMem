/**
 * midmem-workcapture OpenClaw plugin entry.
 *
 * Registers a `message_sent` hook via api.on() that captures
 * outbound message content into midmem work-events.
 *
 * Fail-open, deterministic, no LLM judgment.
 * Erasable-types-only TypeScript (Node 24 type stripping).
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deriveKind, shouldCapture, _resetDebounce, emit } from "./emit.js";

// --- module-level debounce state ---

const _debounceMap: Map<string, number> = new Map();
const DEBOUNCE_MAX = 256;

function _shouldDebounce(sessionKey: string): boolean {
  const now = Date.now();
  const last = _debounceMap.get(sessionKey);
  if (last !== undefined && now - last < 30 * 1000) {
    return true;
  }
  return false;
}

function _recordEmit(sessionKey: string): void {
  const now = Date.now();
  _debounceMap.set(sessionKey, now);
  if (_debounceMap.size > DEBOUNCE_MAX) {
    const oldestKey = _debounceMap.keys().next().value;
    if (oldestKey !== undefined) {
      _debounceMap.delete(oldestKey);
    }
  }
}

// --- handler ---

function handleMessageSent(
  event: { to?: string; content?: unknown; success?: boolean; messageId?: string; sessionKey?: string; runId?: string; error?: string },
  _ctx: unknown
): void {
  try {
    // 1. Kill switch
    const disabled = process.env["MIDMEM_WORKCAPTURE_DISABLED"]?.toLowerCase();
    if (disabled === "1" || disabled === "true" || disabled === "yes" || disabled === "on") {
      return;
    }

    // 2. Extract fields — TOP LEVEL (NOT event.context.content)
    const content = String(event?.content ?? "");
    const sessionKey = String(event?.sessionKey ?? "unknown");

    // 3. Salience gate
    if (content.trim().length < 200) {
      return;
    }

    // 4. Debounce
    if (_shouldDebounce(sessionKey)) {
      return;
    }

    // 5. Kind derivation
    const kind = deriveKind(content);

    // 6. Build fields
    const task = sessionKey;
    const collapsed = content.split(/\s+/).join(" ").trim();
    const truncated = collapsed.length > 500 ? collapsed.slice(0, 500) : collapsed;
    const source = "openclaw:" + (event?.to ?? "chan") + ":sent:" + (event?.messageId ?? event?.runId ?? "n/a");

    // 7. Record emit for debounce
    _recordEmit(sessionKey);

    // 8. Emit — detached child, never awaited
    emit(kind, task, truncated, source);
  } catch (_err) {
    // Entire body fail-open — swallowed
  }
}

// --- plugin entry ---

export default definePluginEntry({
  id: "midmem-workcapture",
  name: "midmem-workcapture",
  description: "Deterministically record a midmem work-event per delivered agent reply (message_sent). Fail-open, no LLM judgment.",
  register(api: { on: (name: string, handler: Function, opts?: { timeoutMs?: number }) => void }): void {
    api.on("message_sent", handleMessageSent, { timeoutMs: 5000 });
  },
});
