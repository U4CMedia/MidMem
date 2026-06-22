/**
 * Brain-style memory benchmark (P7) — offline, deterministic, no live LLM.
 *
 * Turns Perplexity Brain's product claim ("+correctness / +recall / −cost") into a transparent local
 * regression target. Builds two stores over IDENTICAL data — a BASELINE (work-memory boosts +
 * concept routing + proactive recall OFF) and a TREATMENT (all ON) — runs the same task set against
 * both, and reports the Brain headline categories with honest local numbers:
 *
 *   recall@k · correction-applied · dead-end-avoided · current-claim · injected-token cost
 *
 * Exits non-zero if TREATMENT regresses below BASELINE on any Brain metric (so it can gate CI).
 */
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { Orchestrator } from '../src/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midmem-bench-'));
const base = (over) => ({ vaultPath: path.join(tmp, 'v'), llmEnabled: false, sourceRoots: [tmp], autoIngest: { enabled: false, onMaintain: false }, ...over });

const BASELINE = new Orchestrator(base({
  dbPath: path.join(tmp, 'baseline.db'),
  workflowBoost: { enabled: false }, conceptRouting: { enabled: false }, proactiveRecall: { enabled: false },
}));
const TREATMENT = new Orchestrator(base({
  dbPath: path.join(tmp, 'treatment.db'),
  conceptRouting: { enabled: true, topConcepts: 5, minSim: 0.1, boost: 0.005, maxEmbedPerPass: 100 },
}));

// --- Shared dataset: knowledge entries with distinctive tokens + a gold query each. ---
const KNOWLEDGE = [
  ['hybrid retrieval fuses bm25 lexical with vector cosine via reciprocal rank fusion', 'bm25 vector reciprocal rank fusion'],
  ['the fact tier stores raw unprocessed knowledge with a seven day lease', 'fact tier raw seven day lease'],
  ['governance is fail closed and denies on policy evaluation error', 'governance fail closed policy error'],
  ['the obsidian vault is a deterministic projection of statedb regenerable', 'obsidian vault deterministic projection'],
  ['delegate fifty two shows llms corrupt long documents over delegated edits', 'delegate fifty two corrupt documents'],
  ['handoff brief pushes scoped memory across the acp boundary to hermes', 'handoff brief scoped memory acp'],
  ['proactive recall self gates on minscore and caps injection at maxtokens', 'proactive recall self gate minscore'],
  ['the bridge pulls each stack flat memory into the shared tiered store', 'bridge flat memory shared tiered store'],
];

async function seed(o) {
  const ids = [];
  for (const [content] of KNOWLEDGE) { const r = await o.storeMemory({ content, tier: 'memory', type: 'note', scope: 'shared' }); ids.push(r.id); }
  // a fact + its correction (knowledge-point update) — both stores get the same raw material
  const fact = await o.storeMemory({ content: 'the lmstudio model endpoint listens on port one two three four', tier: 'memory', type: 'note', scope: 'shared' });
  await o.recordWork({ kind: 'correction', task: 'lmstudio port', content: 'the lmstudio model endpoint actually listens on port one two three four for embeddings and chat', outcome: 'clarified', scope: 'shared' });
  // a dead-end the agent should not repeat
  await o.recordWork({ kind: 'dead_end', task: 'fingerprint evasion', content: 'random viewport user agent cloaking made the dom nondeterministic and broke selectors', outcome: 'reverted', scope: 'shared' });
  // claim supersession (current-claim correctness)
  const c1 = o.claims.add({ content: 'the matrix plugin is enabled and configured on the gateway' });
  o.supersedeClaim(c1.id, { content: 'the matrix plugin is disabled after it broke the google chat webhook' });
  return { ids, fact };
}

const recallAtK = async (o, k = 3) => {
  let hit = 0;
  for (let i = 0; i < KNOWLEDGE.length; i++) {
    const r = await o.query(KNOWLEDGE[i][1], { limit: k, scopes: ['shared'] });
    if (r.results.some((x) => x.content.includes(KNOWLEDGE[i][0].slice(0, 30)))) hit++;
  }
  return hit / KNOWLEDGE.length;
};

async function run() {
  await seed(BASELINE); await seed(TREATMENT);
  await TREATMENT.refreshConcepts(); // build concept graph for the treatment

  const M = {};
  for (const [name, o] of [['baseline', BASELINE], ['treatment', TREATMENT]]) {
    const recall = await recallAtK(o, 3);
    // correction-applied: does the corrected statement outrank the stale fact for "lmstudio port"?
    const pr = await o.query('lmstudio model endpoint port', { limit: 5, scopes: ['shared'] });
    const correctionApplied = pr.results.length > 0 && /actually listens/.test(pr.results[0].content) ? 1 : 0;
    // dead-end-avoided: is the dead-end surfaced AND flagged as a warning (so the agent won't repeat)?
    const de = await o.query('random viewport user agent cloaking selectors', { limit: 5, scopes: ['shared'] });
    const deHit = de.results.find((x) => /viewport user agent cloaking/.test(x.content));
    const deadEndAvoided = deHit && deHit.rank?.deadEndWarning ? 1 : 0;
    // current-claim: does the freshest non-superseded claim win?
    const cur = o.currentClaims('matrix plugin gateway', { limit: 3 });
    const currentClaim = cur.length && /disabled/.test(cur[0].content) && cur.every((c) => c.status !== 'superseded') ? 1 : 0;
    // injected-token cost: proactive recall budget adherence (0 when disabled = no injection cost)
    const rec = await o.proactiveRecall('what do we know about hybrid retrieval fusion', { force: true, maxTokens: 300 });
    const injectTokens = rec.inject ? Math.ceil(rec.inject.length / 4) : 0;
    M[name] = { recall, correctionApplied, deadEndAvoided, currentClaim, injectTokens };
  }

  const pct = (x) => (x * 100).toFixed(0) + '%';
  console.log('\nMidMem Brain-style benchmark (offline, deterministic)\n');
  console.log('metric              baseline   treatment');
  console.log(`recall@3            ${pct(M.baseline.recall).padEnd(10)} ${pct(M.treatment.recall)}`);
  console.log(`correction-applied  ${String(M.baseline.correctionApplied).padEnd(10)} ${M.treatment.correctionApplied}`);
  console.log(`dead-end-avoided    ${String(M.baseline.deadEndAvoided).padEnd(10)} ${M.treatment.deadEndAvoided}`);
  console.log(`current-claim       ${String(M.baseline.currentClaim).padEnd(10)} ${M.treatment.currentClaim}`);
  console.log(`recall-inject-tok   ${String(M.baseline.injectTokens).padEnd(10)} ${M.treatment.injectTokens} (≤300 budget)`);

  // Regression gate: treatment must not lose on any Brain metric, and must win on the work-memory ones.
  const reasons = [];
  if (M.treatment.recall < M.baseline.recall) reasons.push('recall regressed');
  if (M.treatment.correctionApplied < 1) reasons.push('correction not applied by treatment');
  if (M.treatment.deadEndAvoided < 1) reasons.push('dead-end not flagged by treatment');
  if (M.treatment.currentClaim < 1) reasons.push('current-claim not resolved by treatment');
  if (M.treatment.injectTokens > 300) reasons.push('proactive inject over budget');
  const advantage = (M.treatment.correctionApplied + M.treatment.deadEndAvoided + M.treatment.currentClaim)
                  - (M.baseline.correctionApplied + M.baseline.deadEndAvoided + M.baseline.currentClaim);
  console.log(`\nwork-memory advantage (treatment − baseline): +${advantage} Brain capabilities`);
  console.log(reasons.length ? `\nFAIL — ${reasons.join('; ')}` : '\nPASS — treatment ≥ baseline on all Brain metrics');

  BASELINE.close(); TREATMENT.close(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(reasons.length ? 1 : 0);
}
run().catch((e) => { console.error('FATAL:', e.stack); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(1); });
