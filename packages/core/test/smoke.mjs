/**
 * End-to-end smoke test (offline, no external deps, no live LLM).
 * Exercises: ingest → hybrid retrieval → governance (fail-closed) → verify → projection.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator, GovernanceError } from '../src/index.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
async function denies(fn, msg) { try { await fn(); fail++; console.log(`  ✗ ${msg} (expected denial)`); } catch (e) { ok(e instanceof GovernanceError, `${msg} → ${e.message}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmw-'));
const o = new Orchestrator({
  dbPath: path.join(tmp, 'state.db'),
  vaultPath: path.join(tmp, 'vault'),
  llmEnabled: false,
  sourceRoots: [tmp],
});

try {
  console.log('Foundation smoke test\n');

  // 1. Ingest
  const src = path.join(tmp, 'sample.md');
  fs.writeFileSync(src, 'Hybrid retrieval fuses BM25 lexical search with vector cosine similarity. ' +
    'Reciprocal Rank Fusion combines the two ranked lists. Vectors come from a local embedding model.');
  const ing = await o.ingest({ path: src, type: 'note', title: 'Hybrid RAG' });
  ok(ing.success, 'ingest succeeded');
  ok(ing.concepts > 0, `extracted ${ing.concepts} concepts (fallback mode=${ing.mode})`);
  ok(ing.claims > 0, `extracted ${ing.claims} claims`);

  // 2. Governance: path traversal blocked
  await denies(() => o.ingest({ path: '/etc/passwd', type: 'note' }), 'ingest outside source roots blocked');

  // 3. More memories + hybrid query
  await o.storeMemory({ content: 'The fact tier stores raw unprocessed knowledge from sources.', tier: 'fact', type: 'note' });
  await o.storeMemory({ content: 'A sourdough recipe needs flour, water, salt and starter.', tier: 'memory', type: 'note' });
  const q = await o.query('vector cosine fusion retrieval', { limit: 5 });
  ok(q.results.length > 0, `hybrid query returned ${q.results.length} results`);
  ok(/hybrid|vector|fusion|retrieval/i.test(q.results[0].content), `top result is relevant: "${q.results[0].content.slice(0, 50)}…"`);
  ok(q.results[0].rank.fts != null || q.results[0].rank.vector != null, 'top result has lexical and/or vector rank components');

  // 4. Governance: curated-only wisdom tier
  await denies(() => o.storeMemory({ content: 'curated truth', tier: 'wisdom', type: 'note' }), 'uncurated write to wisdom tier blocked');
  const w = await o.storeMemory({ content: 'curated truth', tier: 'wisdom', type: 'note', curated: true });
  ok(w.success, 'curated write to wisdom tier allowed');

  // 5. Governance: hard delete guard
  await denies(() => o.forget(w.id, { soft: false }), 'hard delete without force blocked');
  const soft = await o.forget(w.id, { soft: true });
  ok(soft.success, 'soft delete allowed');

  // 6. Verify + lint
  const lint = o.lint();
  ok(Array.isArray(lint.contradictions), `lint ran (${lint.summary.entries} entries, ${lint.summary.nodes} nodes)`);

  // 7. Projection to vault
  const proj = o.project();
  ok(proj.written > 0, `projected ${proj.written} files to vault`);
  ok(fs.existsSync(path.join(proj.vaultPath, 'index.md')), 'index.md projected');

  // 8. Brief
  const b = o.brief();
  ok(b.tiers.memory >= 1 && b.tiers.fact >= 1, `brief reports tier counts: ${JSON.stringify(b.tiers)}`);
  ok(b.vectors?.backend === 'sqlite', `vector backend reported via brief: ${b.vectors?.backend}`);

  // 9. Cross-agent scope isolation (#2)
  await o.storeMemory({ content: 'OPENCLAW_ONLY beacon zebra marker', tier: 'memory', scope: 'openclaw' });
  await o.storeMemory({ content: 'HERMES_ONLY beacon zebra marker', tier: 'memory', scope: 'hermes' });
  const ocq = await o.query('beacon zebra marker', { scopes: ['openclaw'], limit: 5 });
  ok(ocq.results.some((r) => /OPENCLAW_ONLY/.test(r.content)) && !ocq.results.some((r) => /HERMES_ONLY/.test(r.content)),
    'scope filter returns openclaw entry, excludes hermes');
  const shq = await o.query('beacon zebra marker', { scopes: ['shared'], limit: 5 });
  ok(!shq.results.some((r) => /OPENCLAW_ONLY|HERMES_ONLY/.test(r.content)), 'shared-scope query excludes both private entries');

  // 10. Native→middleware bridge + hash dedup (#1)
  const srcDir = path.join(tmp, 'bridge-src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'note1.md'), 'Bridged note: retrieval-augmented generation fuses search with generation.');
  const { bridgeMemory } = await import('../src/index.mjs');
  const b1 = await bridgeMemory(o, { sources: [{ dir: srcDir, scope: 'openclaw', type: 'note' }], project: false });
  ok(b1.ingested === 1, `bridge ingested ${b1.ingested} new file`);
  const b2 = await bridgeMemory(o, { sources: [{ dir: srcDir, scope: 'openclaw', type: 'note' }], project: false });
  ok(b2.ingested === 0 && b2.skipped === 1, `bridge re-run is idempotent (dedup): ingested ${b2.ingested}, skipped ${b2.skipped}`);

  // 11. Trust feedback loop (borrow)
  const fb = await o.storeMemory({ content: 'Trust feedback target about kubernetes operators.', tier: 'memory', scope: 'shared' });
  const before = o.recall(fb.id).trust_score;
  o.feedback(fb.id, true);
  ok(o.recall(fb.id).trust_score > before, `feedback raised trust ${before} → ${o.recall(fb.id).trust_score}`);

  // 12. Token-budget retrieval (borrow)
  const tb = await o.query('hybrid vector retrieval', { maxTokens: 80, limit: 10 });
  const totalTok = tb.results.reduce((s, r) => s + Math.ceil(r.content.length / 4), 0);
  ok(totalTok <= 80, `token budget respected (${totalTok} ≤ 80 tok across ${tb.results.length} results)`);

  // 13. Trigram substring lane (borrow) — query a non-token substring
  await o.storeMemory({ content: 'The authentication subsystem uses OAuth2 tokens.', tier: 'memory', scope: 'shared' });
  const tg = await o.query('thenticat', { scopes: ['shared'], limit: 5 });
  ok(tg.results.some((r) => /authentication/i.test(r.content)), 'trigram lane finds substring (non-token) match');

  // 14. Embedding dimension guard (borrow)
  let dimGuard = false;
  try {
    await o.memory.upsertVector('dimtest-1', new Array(1024).fill(0.1), 'real-model-a', 'lmstudio');
    await o.memory.upsertVector('dimtest-2', new Array(768).fill(0.1), 'real-model-b', 'lmstudio');
  } catch (e) { dimGuard = /dim mismatch/i.test(e.message); }
  ok(dimGuard, 'dim guard rejects mixing real-model vector dimensions');

  // 15. Hand-off memory gate (firstware) — local + frontier profiles
  const hbLocal = await o.handoffBrief({ task: 'hybrid retrieval vector fusion', profile: 'local' });
  ok(/AUTHORITATIVE MEMORY/.test(hbLocal.brief) && hbLocal.count >= 1,
    `local hand-off brief: authoritative framing, ${hbLocal.count} items, ~${hbLocal.tokensEstimate} tok`);
  const hbFrontier = await o.handoffBrief({ task: 'hybrid retrieval vector fusion', profile: 'frontier' });
  ok(/Retrieved memory/.test(hbFrontier.brief) && /recall|query/.test(hbFrontier.brief) && /trust/.test(hbFrontier.brief),
    'frontier hand-off brief: provenance/trust + invites pull');
  const hbEmpty = await o.handoffBrief({ task: 'anything', profile: 'local', scopes: ['void_scope'] });
  ok(hbEmpty.count === 0 && /no prior knowledge/i.test(hbEmpty.brief), 'empty hand-off brief degrades cleanly');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('\nFATAL:', e.stack); fail++;
} finally {
  o.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
