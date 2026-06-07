/**
 * Hybrid retrieval — the core RAG path.
 *
 * Lexical (SQLite FTS5/BM25) ⊕ semantic (vector cosine) fused by Reciprocal
 * Rank Fusion. Returns ranked, provenance-bearing results. This is what the
 * scaffold never had: FTS was dead code and vectors were never queried.
 */
import { ftsMatchExpr, cosine } from './util.mjs';

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./embeddings.mjs').Embedder} embedder
 */
export async function hybridSearch(db, memory, embedder, query, opts = {}) {
  const { tiers = memory.tierNames, scopes = null, limit = 20, includeProvenance = true } = opts;
  const k = memory.cfg.rrfK;
  const w = memory.cfg.fusionWeights;
  const scoped = scopes && scopes.length ? scopes : null;

  // --- Lexical (FTS5 / BM25) ---
  const fts = [];
  const expr = ftsMatchExpr(query);
  if (expr) {
    const conds = ["e.status='active'", `e.tier IN (${tiers.map(() => '?').join(',')})`];
    const params = [expr, ...tiers];
    if (scoped) { conds.push(`e.scope IN (${scoped.map(() => '?').join(',')})`); params.push(...scoped); }
    const rows = db.prepare(`
      SELECT e.id id, e.rowid rowid, bm25(entries_fts) rank
      FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
      WHERE entries_fts MATCH ? AND ${conds.join(' AND ')}
      ORDER BY rank LIMIT 200
    `).all(...params);
    rows.forEach((r) => fts.push(r.id));
  }

  // --- Semantic (vector cosine) ---
  const { vector: qv } = await embedder.embed(query);
  const scored = memory.activeVectors(tiers, scoped)
    .map((v) => ({ id: v.id, sim: cosine(qv, v.vector) }))
    .filter((x) => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 200);
  const vec = scored.map((x) => x.id);

  // --- Reciprocal Rank Fusion ---
  const fused = new Map(); // id -> {score, fts, vector}
  const bump = (id, rank, kind, weight) => {
    const e = fused.get(id) || { score: 0, fts: null, vector: null };
    e.score += weight * (1 / (k + rank));
    e[kind] = rank + 1;
    fused.set(id, e);
  };
  fts.forEach((id, i) => bump(id, i, 'fts', w.fts));
  vec.forEach((id, i) => bump(id, i, 'vector', w.vector));

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);

  return ranked.map(([id, meta]) => {
    const e = memory.get(id);
    return {
      id,
      tier: e?.tier,
      type: e?.type,
      content: e ? e.content.slice(0, 600) + (e.content.length > 600 ? '…' : '') : '',
      score: Number(meta.score.toFixed(6)),
      rank: { fts: meta.fts, vector: meta.vector },
      provenance: includeProvenance ? e?.provenance ?? null : undefined,
    };
  });
}
