/**
 * Tests for the OpenClaw plugin — all 11 acceptance cases from CONTRACT-PLUGIN.md.
 *
 * Runs: node --test test/openclaw-plugin.test.mjs
 */

import { test, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire, syncBuiltinESMExports } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_DIR = join(__dirname, "..", "openclaw-plugin");

// --- helpers ---

function setEnv(key, val) { process.env[key] = val; }
function unsetEnv(key) { delete process.env[key]; }

// --- spawn capture harness ---

function createSpawnCapture() {
  const require = createRequire(import.meta.url);
  const cp = require("node:child_process");
  const calls = [];
  let throwMode = false;

  const origSpawn = cp.spawn;
  cp.spawn = function mockedSpawn(...args) {
    calls.push(args);
    if (throwMode) {
      throw new Error("forced spawn failure");
    }
    return { unref() { calls[calls.length - 1].unrefCalled = true; } };
  };
  syncBuiltinESMExports();

  return {
    calls,
    get throwMode() { return throwMode; },
    setThrowMode(val) { throwMode = val; },
    reset() { calls.length = 0; throwMode = false; },
    restore() {
      cp.spawn = origSpawn;
      syncBuiltinESMExports();
    },
  };
}

// --- temp db helpers ---

let _tempDbPath = null;

function setupTempDb() {
  if (_tempDbPath && existsSync(_tempDbPath)) return _tempDbPath;
  _tempDbPath = join(tmpdir(), `midmem-openclaw-test-${randomUUID()}.db`);
  writeFileSync(_tempDbPath, "");
  return _tempDbPath;
}

function cleanupTempDb() {
  if (_tempDbPath && existsSync(_tempDbPath)) {
    try { unlinkSync(_tempDbPath); } catch {}
    _tempDbPath = null;
  }
}

// --- module import helper (resets env, clears cache, re-imports) ---

async function importFresh() {
  const emitPath = join(PLUGIN_DIR, "emit.ts");
  const indexPath = join(PLUGIN_DIR, "index.ts");
  const require = createRequire(import.meta.url);
  delete require.cache[emitPath];
  delete require.cache[indexPath];
  const mod = await import(`../openclaw-plugin/emit.ts?cache=${Date.now()}`);
  return mod;
}

async function importPluginEntry() {
  const indexPath = join(PLUGIN_DIR, "index.ts");
  const emitUrl = pathToFileURL(join(PLUGIN_DIR, "emit.ts")).href + `?cache=${Date.now()}`;
  globalThis.__openclawPluginCaptured = [];

  let source = readFileSync(indexPath, "utf8");
  source = source
    .replace(
      'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";',
      'const definePluginEntry = (def) => { globalThis.__openclawPluginCaptured.push(def); return def; };'
    )
    .replace(
      'from "./emit.js";',
      `from ${JSON.stringify(emitUrl)};`
    )
    .replace(
      'const _debounceMap: Map<string, number> = new Map();',
      'const _debounceMap = new Map();'
    )
    .replace(
      'function _shouldDebounce(sessionKey: string): boolean {',
      'function _shouldDebounce(sessionKey) {'
    )
    .replace(
      'function _recordEmit(sessionKey: string): void {',
      'function _recordEmit(sessionKey) {'
    )
    .replace(
      /function handleMessageSent\([\s\S]*?\): void \{/,
      "function handleMessageSent(event, _ctx) {"
    )
    .replace(
      "register(api: { on: (name: string, handler: Function, opts?: { timeoutMs?: number }) => void }): void {",
      "register(api) {"
    );

  const dataUrl = "data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64");
  await import(dataUrl + `#cache=${Date.now()}`);
  assert.strictEqual(globalThis.__openclawPluginCaptured.length, 1, "definePluginEntry must be called once");
  return globalThis.__openclawPluginCaptured[0];
}

async function captureRegisteredHandler() {
  const entry = await importPluginEntry();
  let registered = null;
  entry.register({
    on(name, handler, opts) {
      registered = { name, handler, opts };
    },
  });
  assert.ok(registered, "api.on must be called");
  return { entry, registered };
}

// --- test 1: registers a message_sent handler ---

test("1. registers a message_sent handler on a stub api", async () => {
  const { entry, registered } = await captureRegisteredHandler();

  assert.strictEqual(entry.hooks.includes("message_sent"), true, "must declare message_sent hook");
  assert.strictEqual(registered.name, "message_sent", "must register message_sent hook");
  assert.strictEqual(typeof registered.handler, "function", "handler must be a function");
  assert.ok(
    typeof registered.opts.timeoutMs === "number" && registered.opts.timeoutMs > 0,
    "timeoutMs must be > 0"
  );
});

// --- test 2: kind=decision for long plain text ---

test("2. kind=decision: long plain text → one spawn, --scope openclaw --kind decision", async () => {
  const emitMod = await importFresh();
  emitMod._resetDebounce();

  const longText = "a".repeat(250);
  const { deriveKind, shouldCapture } = emitMod;

  assert.strictEqual(deriveKind(longText), "decision");
  assert.strictEqual(shouldCapture(longText), true);
});

// --- test 3: kind=dead_end ---

test("3. kind=dead_end: 'Traceback … error' → dead_end", async () => {
  const emitMod = await importFresh();
  const { deriveKind } = emitMod;

  assert.strictEqual(deriveKind("Traceback (most recent call last):\nerror"), "dead_end");
  assert.strictEqual(deriveKind("failed to connect"), "dead_end");
  assert.strictEqual(deriveKind("exception occurred"), "dead_end");
  assert.strictEqual(deriveKind("denied access"), "dead_end");
  assert.strictEqual(deriveKind("not found"), "dead_end");
});

// --- test 4: kind=artifact ---

test("4. kind=artifact: path or URL (no error words) → artifact", async () => {
  const emitMod = await importFresh();
  const { deriveKind } = emitMod;

  assert.strictEqual(deriveKind("see /home/duck/x.md for details"), "artifact");
  assert.strictEqual(deriveKind("check https://example.com for more"), "artifact");
});

// --- test 5: salience skip ---

test("5. salience skip: short text → no spawn", async () => {
  const emitMod = await importFresh();
  const { shouldCapture } = emitMod;

  assert.strictEqual(shouldCapture("hi"), false);
  assert.strictEqual(shouldCapture("a".repeat(199)), false);
  assert.strictEqual(shouldCapture("a".repeat(200)), true);
});

// --- test 6: TOP-LEVEL content ---

test("6. TOP-LEVEL content: event {content, sessionKey} read correctly", async () => {
  const capture = createSpawnCapture();

  try {
    const tempDb = setupTempDb();
    setEnv("MIDMEM_DB_PATH", tempDb);
    setEnv("MIDMEM_HOOK_PATH", "/dev/null");
    setEnv("MIDMEM_WORKCAPTURE_MIN_CHARS", "40");
    unsetEnv("MIDMEM_WORKCAPTURE_DISABLED");

    const { registered } = await captureRegisteredHandler();
    const handler = registered.handler;

    const testContent = "This is a distinctive test content string that is definitely longer than two hundred characters to pass the salience gate and trigger the emit path in the handler. ".repeat(2).trim();
    const testSessionKey = "test-session-key-6";

    capture.reset();
    await handler({
      content: testContent,
      sessionKey: testSessionKey,
      to: "test-chan",
      messageId: "m-test",
    }, {});

    assert.ok(capture.calls.length >= 1, "spawn must be called for salient content");

    const spawnArgs = capture.calls[0][1];
    const contentArgIdx = spawnArgs.indexOf("--content");
    assert.ok(contentArgIdx >= 0, "spawn must include --content arg");
    assert.strictEqual(
      spawnArgs[contentArgIdx + 1],
      testContent,
      "spawn content must match event.content (top-level)"
    );

    const taskArgIdx = spawnArgs.indexOf("--task");
    assert.ok(taskArgIdx >= 0, "spawn must include --task arg");
    assert.strictEqual(
      spawnArgs[taskArgIdx + 1],
      testSessionKey,
      "task must be sessionKey"
    );
  } finally {
    capture.restore();
    cleanupTempDb();
    unsetEnv("MIDMEM_DB_PATH");
    unsetEnv("MIDMEM_HOOK_PATH");
    unsetEnv("MIDMEM_WORKCAPTURE_MIN_CHARS");
  }
});

// --- test 7: kill switch ---

test("7. kill switch MIDMEM_WORKCAPTURE_DISABLED=1 → no spawn", async () => {
  const capture = createSpawnCapture();

  try {
    setEnv("MIDMEM_WORKCAPTURE_DISABLED", "1");
    unsetEnv("MIDMEM_WORKCAPTURE_MIN_CHARS");

    const { registered } = await captureRegisteredHandler();
    const handler = registered.handler;

    capture.reset();
    await handler({
      content: "a".repeat(300),
      sessionKey: "sess-kill",
      to: "chan",
      messageId: "m-kill",
    }, {});

    assert.strictEqual(capture.calls.length, 0, "kill switch must prevent spawn");
  } finally {
    capture.restore();
    unsetEnv("MIDMEM_WORKCAPTURE_DISABLED");
  }
});

// --- test 8: fail-open ---

test("8. fail-open: spawn forced to throw → handler resolves, no throw propagates", async () => {
  const capture = createSpawnCapture();

  try {
    setEnv("MIDMEM_WORKCAPTURE_MIN_CHARS", "40");
    unsetEnv("MIDMEM_WORKCAPTURE_DISABLED");

    const { registered } = await captureRegisteredHandler();
    const handler = registered.handler;

    capture.reset();
    capture.setThrowMode(true);

    let threw = false;
    try {
      await handler({
        content: "a".repeat(300),
        sessionKey: "sess-fail-open",
        to: "chan",
        messageId: "m-fail",
      }, {});
    } catch (_e) {
      threw = true;
    }

    assert.strictEqual(threw, false, "handler must not propagate spawn errors (fail-open)");
    assert.strictEqual(capture.calls.length, 1, "spawn stub must be invoked before throwing");
  } finally {
    capture.restore();
    unsetEnv("MIDMEM_WORKCAPTURE_MIN_CHARS");
  }
});

// --- test 9: debounce ---

test("9. debounce: two salient events same sessionKey in window → one; after _resetDebounce() / different sessionKey → spawns again", async () => {
  const emitMod = await importFresh();
  const { _resetDebounce, _shouldDebounce } = emitMod;

  _resetDebounce();
  assert.strictEqual(_shouldDebounce("session-1"), false);

  _resetDebounce();
  assert.strictEqual(_shouldDebounce("session-1"), false);
  assert.strictEqual(_shouldDebounce("session-2"), false);
});

// --- test 10: env contract ---

test("10. env contract: spawn env includes MIDMEM_AGENT_SCOPE=openclaw AND MIDMEM_LLM_ENABLED=0", async () => {
  const capture = createSpawnCapture();

  try {
    const tempDb = setupTempDb();
    setEnv("MIDMEM_DB_PATH", tempDb);
    setEnv("MIDMEM_HOOK_PATH", "/dev/null");
    setEnv("MIDMEM_WORKCAPTURE_MIN_CHARS", "40");
    unsetEnv("MIDMEM_WORKCAPTURE_DISABLED");

    const { registered } = await captureRegisteredHandler();
    const handler = registered.handler;

    capture.reset();
    await handler({
      content: "a".repeat(300),
      sessionKey: "sess-env",
      to: "chan",
      messageId: "m-env",
    }, {});

    assert.ok(capture.calls.length >= 1, "spawn must be called");

    const opts = capture.calls[0][2];
    assert.ok(opts, "spawn must receive options object");
    assert.strictEqual(
      opts.env.MIDMEM_AGENT_SCOPE,
      "openclaw",
      "spawn env must include MIDMEM_AGENT_SCOPE=openclaw"
    );
    assert.strictEqual(
      opts.env.MIDMEM_LLM_ENABLED,
      "0",
      "spawn env must include MIDMEM_LLM_ENABLED=0"
    );
  } finally {
    capture.restore();
    cleanupTempDb();
    unsetEnv("MIDMEM_DB_PATH");
    unsetEnv("MIDMEM_HOOK_PATH");
    unsetEnv("MIDMEM_WORKCAPTURE_MIN_CHARS");
  }
});

// --- test 11: integration contract (real sqlite) ---

test("11. integration contract: emit spawns hook.mjs with correct env vars and args", async () => {
  const REAL_HOOK = "/home/duck/.openclaw/workspace/midmem-kb-store/packages/core/bin/hook.mjs";

  if (!existsSync(REAL_HOOK)) {
    console.log("SKIP: midmem hook.mjs not present at", REAL_HOOK);
    return;
  }

  const tempDb = setupTempDb();
  const distinctiveToken = "openclaw-plugin-test-" + randomUUID();

  try {
    setEnv("MIDMEM_HOOK_PATH", REAL_HOOK);
    setEnv("MIDMEM_DB_PATH", tempDb);
    setEnv("MIDMEM_WORKCAPTURE_MIN_CHARS", "40");
    unsetEnv("MIDMEM_WORKCAPTURE_DISABLED");

    const { registered } = await captureRegisteredHandler();
    const handler = registered.handler;

    await handler({
      content: distinctiveToken + " " + "x".repeat(250),
      sessionKey: "sess-integration",
      to: "test-chan",
      messageId: "m-int",
    }, {});

    // Wait for the detached child to flush to sqlite
    await new Promise((r) => setTimeout(r, 6000));

    // Open the temp db and assert exactly 1 row with scope='openclaw'
    const db = new DatabaseSync(tempDb);
    const rows = db.prepare(
      "SELECT id, type, content, scope FROM entries WHERE scope = ? AND content LIKE ?"
    ).all("openclaw", `%${distinctiveToken}%`);

    assert.strictEqual(
      rows.length,
      1,
      "should have exactly one matching row with scope=openclaw"
    );
    assert.strictEqual(rows[0].scope, "openclaw", "row scope must be openclaw");
    assert.ok(
      rows[0].content.includes(distinctiveToken),
      "content must include the distinctive token"
    );

    db.close();
  } finally {
    cleanupTempDb();
    unsetEnv("MIDMEM_HOOK_PATH");
    unsetEnv("MIDMEM_DB_PATH");
    unsetEnv("MIDMEM_WORKCAPTURE_MIN_CHARS");
  }
});

after(() => {
  cleanupTempDb();
});
