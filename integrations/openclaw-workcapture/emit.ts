/**
 * midmem-workcapture OpenClaw plugin — pure helpers.
 *
 * No side effects. Re-exported for tests.
 */

import { spawn } from "node:child_process";

// --- env helpers ---

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const val = env(name, "");
  if (val) {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function envBool(name: string): boolean {
  const val = env(name, "").toLowerCase();
  return val === "1" || val === "true" || val === "yes" || val === "on";
}

// --- module-level constants (env read ONCE at import time) ---

let MIN_CHARS: number = envInt("MIDMEM_WORKCAPTURE_MIN_CHARS", 200);
let MAX_CHARS: number = envInt("MIDMEM_WORKCAPTURE_MAX_CHARS", 500);
let TIMEOUT: number = envInt("MIDMEM_WORKCAPTURE_TIMEOUT", 12);
let NODE: string = env("MIDMEM_WORKCAPTURE_NODE", "node");
let HOOK_PATH: string = env(
  "MIDMEM_HOOK_PATH",
  "/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs"
);
let DB_PATH: string = env("MIDMEM_DB_PATH", "/home/duck/.openclaw/workspace/midmem-kb-store/state.db");
let DEBOUNCE_S: number = envInt("MIDMEM_WORKCAPTURE_DEBOUNCE_S", 30);
let DISABLED: boolean = envBool("MIDMEM_WORKCAPTURE_DISABLED");

// --- debounce (per sessionKey) ---

const _debounceMap: Map<string, number> = new Map();
const DEBOUNCE_MAX = 256;

export function shouldCapture(text: string): boolean {
  return text.trim().length >= MIN_CHARS;
}

export function deriveKind(text: string): string {
  const ERROR_RE = /\b(error|failed|exception|traceback|denied|not found)\b/i;
  const FS_PATH_RE = /\/[^\s]{3,}/;
  const URL_RE = /https?:\/\/\S+/;

  if (ERROR_RE.test(text)) return "dead_end";
  if (FS_PATH_RE.test(text) || URL_RE.test(text)) return "artifact";
  return "decision";
}

export function _resetDebounce(): void {
  _debounceMap.clear();
}

export function _shouldDebounce(sessionKey: string): boolean {
  const now = Date.now();
  const last = _debounceMap.get(sessionKey);
  if (last !== undefined && now - last < DEBOUNCE_S * 1000) {
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

// --- collapse + truncate ---

function collapseWhitespace(s: string): string {
  return s.split(/\s+/).join(" ").trim();
}

function truncate(s: string, maxChars: number): string {
  const collapsed = collapseWhitespace(s);
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

// --- buildArgs ---

export function buildArgs(
  kind: string,
  task: string,
  content: string,
  source: string
): string[] {
  return [
    HOOK_PATH,
    "post",
    "--kind", kind,
    "--scope", "openclaw",
    "--task", task,
    "--content", content,
    "--source", source,
  ];
}

// --- emit (detached spawn) ---

export function emit(
  kind: string,
  task: string,
  content: string,
  source: string
): void {
  try {
    const childEnv: Record<string, string> = { ...process.env };
    childEnv["MIDMEM_DB_PATH"] = DB_PATH;
    childEnv["MIDMEM_AGENT_SCOPE"] = "openclaw";
    childEnv["MIDMEM_LLM_ENABLED"] = "0";
    childEnv["MIDMEM_WORKCAPTURE_TIMEOUT"] = String(TIMEOUT);

    spawn(NODE, [
      HOOK_PATH,
      "post",
      "--kind", kind,
      "--scope", "openclaw",
      "--task", task,
      "--content", content,
      "--source", source,
    ], {
      env: childEnv,
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch (_spawnErr) {
    // fail-open — spawn failure swallowed
  }
}

// --- _reinit for tests ---

export function _reinit(): void {
  MIN_CHARS = envInt("MIDMEM_WORKCAPTURE_MIN_CHARS", 200);
  MAX_CHARS = envInt("MIDMEM_WORKCAPTURE_MAX_CHARS", 500);
  TIMEOUT = envInt("MIDMEM_WORKCAPTURE_TIMEOUT", 12);
  NODE = env("MIDMEM_WORKCAPTURE_NODE", "node");
  HOOK_PATH = env(
    "MIDMEM_HOOK_PATH",
    "/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs"
  );
  DB_PATH = env("MIDMEM_DB_PATH", "/home/duck/.openclaw/workspace/midmem-kb-store/state.db");
  DEBOUNCE_S = envInt("MIDMEM_WORKCAPTURE_DEBOUNCE_S", 30);
  DISABLED = envBool("MIDMEM_WORKCAPTURE_DISABLED");
  _debounceMap.clear();
}
