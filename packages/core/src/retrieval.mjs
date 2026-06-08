/**
 * Hybrid retrieval — the core RAG path.
 *
 * Lanes: SQLite FTS5 (token lexical) ⊕ FTS5-trigram (substring lexical) ⊕ vector cosine
 * (semantic), fused by Reciprocal Rank Fusion. Then: trust boost (usage feedback), graph
 * ref-chain boost (entries sharing concepts with the top hits), and either top-k or a
 * token budget. Returns ranked, provenance-bearing results.
 *
 * (Ideas adapted from memory-os: trust scoring, two-pass ref-chain boost, token budget.)
 */
import { ftsMatchExpr } from './util.mjs';

/** One FTS lane (token or trigram), scope/tier filtered. Returns ranked entry ids. */
function ftsLane(db, table, expr, tiers, scoped, limit = 200) {
  if (!expr) return [];
  const conds = ["e.status='active'", `e.tier IN (${tiers.map(() => '?').join(',')})`];
  const params = [expr, ...tiers];
  if (scoped) { conds.push(`e.scope IN (${scoped.map(() => '?').join(',')})`); params.push(...scoped); }
  return db.prepare(`
    SELECT e.id id FROM ${table} JOIN entries e ON e.rowid = ${table}.rowid
    WHERE ${table} MATCH ? AND ${conds.join(' AND ')}
    ORDER BY bm25(${table}) LIMIT ${limit}
  `).all(...params).map((r) => r.id);
}

/** Filter vector-store candidate ids against live entries (state.db is the metadata authority). */
function filterActiveIds(db, ids, tiers, scoped) {
  if (!ids.length) return new Set();
  const conds = [`id IN (${ids.map(() => '?').join(',')})`, "status='active'", `tier IN (${tiers.map(() => '?').join(',')})`];
  const params = [...ids, ...tiers];
  if (scoped) { conds.push(`scope IN (${scoped.map(() => '?').join(',')})`); params.push(...scoped); }
  return new Set(db.prepare(`SELECT id FROM entries WHERE ${conds.join(' AND ')}`).all(...params).map((r) => r.id));
}

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./embeddings.mjs').Embedder} embedder
 */
export async function hybridSearch(db, memory, embedder, query, opts = {}) {
  const { scopes = null, limit = 20, maxTokens = null, includeProvenance = true } = opts;
  const tiers = (opts.tiers && opts.tiers.length) ? opts.tiers : memory.tierNames;
  const cfg = memory.cfg;
  const k = cfg.rrfK;
  const w = cfg.fusionWeights;
  const scoped = scopes && scopes.length ? scopes : null;
  const expr = ftsMatchExpr(query);

  // --- Lanes ---
  const lanes = {
    fts: ftsLane(db, 'entries_fts', expr, tiers, scoped),
    trigram: ftsLane(db, 'entries_fts_trigram', expr, tiers, scoped),
    vector: [],
  };
  const { vector: qv } = await embedder.embed(query);
  const vraw = await memory.vectorStore.search(qv, 400); // backend-ranked candidates (id+score)
  const vAllowed = filterActiveIds(db, vraw.map((r) => r.id), tiers, scoped);
  lanes.vector = vraw.filter((r) => vAllowed.has(r.id)).slice(0, 200).map((r) => r.id);

  // --- Reciprocal Rank Fusion ---
  const fused = new Map();
  const bump = (id, rank, lane) => {
    const e = fused.get(id) || { score: 0, ranks: {} };
    e.score += (w[lane] ?? 1) * (1 / (k + rank));
    e.ranks[lane] = rank + 1;
    fused.set(id, e);
  };
  for (const lane of ['fts', 'trigram', 'vector']) lanes[lane].forEach((id, i) => bump(id, i, lane));

  // Hydrate candidates once.
  const cand = [...fused.entries()].map(([id, m]) => ({ id, score: m.score, ranks: m.ranks, entry: memory.get(id) })).filter((c) => c.entry);

  // --- Trust boost (usage feedback) ---
  for (const c of cand) c.score += cfg.trustWeight * ((c.entry.trust_score ?? 0.5) - 0.5);

  // --- Graph ref-chain boost: concepts of the current top hits lift entries that share them. ---
  const prelim = [...cand].sort((a, b) => b.score - a.score);
  const topConcepts = new Set();
  for (const c of prelim.slice(0, 5)) for (const k2 of (c.entry.concepts || [])) topConcepts.add(String(k2.name || '').toLowerCase());
  topConcepts.delete('');
  if (topConcepts.size) {
    for (const c of cand) {
      const shared = (c.entry.concepts || []).filter((k2) => topConcepts.has(String(k2.name || '').toLowerCase())).length;
      if (shared) { c.score += cfg.graphBoost * Math.min(shared, 3); c.ranks.graph = shared; }
    }
  }

  cand.sort((a, b) => b.score - a.score);

  const preview = (e) => e.content.slice(0, 600) + (e.content.length > 600 ? '…' : '');

  // --- Token budget (surgical injection) or top-k ---
  let selected;
  if (maxTokens) {
    selected = [];
    let budget = maxTokens;
    for (const c of cand) {
      const cost = Math.ceil(preview(c.entry).length / 4);
      if (cost > budget) continue; // skip oversized, keep filling from the rest
      budget -= cost;
      selected.push(c);
      if (limit && selected.length >= limit) break;
    }
  } else {
    selected = cand.slice(0, limit);
  }

  return selected.map((c) => ({
    id: c.id,
    tier: c.entry.tier,
    type: c.entry.type,
    content: preview(c.entry),
    score: Number(c.score.toFixed(6)),
    trust: c.entry.trust_score,
    rank: c.ranks,
    provenance: includeProvenance ? c.entry.provenance ?? null : undefined,
  }));
}
