/**
 * Concept routing (Phase 2 / P5) — concept-node embeddings + deterministic community detection.
 *
 * Graph build (in maintain, daily/forced only — keeps the hot path cheap):
 *   - embed each concept node from a digest (label + a few linked entries), stored in node.properties;
 *   - assign communities by deterministic label propagation over the edge graph.
 * Retrieval (hot path, fail-soft): the query vector finds the nearest concept nodes; entries linked
 * to those concepts and their communities are SEEDED into the candidate pool + lightly boosted.
 * If nothing is embedded yet, it returns an empty set → retrieval falls back to flat hybrid.
 *
 * No external deps, no per-query LLM traversal (the memo's caution): routing is pure vector + graph.
 */
import { cosine, sha12, nowISO, json } from './util.mjs';

/** Build a deterministic digest for a node: its label + up to N linked entries' content. */
function nodeDigest(db, node, maxEntries = 3) {
  const rows = db.prepare("SELECT content FROM entries WHERE status='active' AND concepts LIKE ? ORDER BY rowid DESC LIMIT ?")
    .all(`%${node.label}%`, maxEntries);
  return [node.label, ...rows.map((r) => r.content.slice(0, 200))].join(' \n ');
}

/** Deterministic label propagation: each node adopts the most common community among neighbors,
 *  ties broken by smallest community id, nodes processed in sorted id order. Persists to properties. */
function detectCommunities(o, rounds = 5) {
  const nodes = o.graph.allNodes().sort((a, b) => a.id.localeCompare(b.id));
  const comm = new Map(nodes.map((n) => [n.id, n.id]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of o.db.prepare('SELECT from_id,to_id FROM edges').all()) {
    if (adj.has(e.from_id)) adj.get(e.from_id).push(e.to_id);
    if (adj.has(e.to_id)) adj.get(e.to_id).push(e.from_id);
  }
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map();
      for (const nb of adj.get(n.id)) { const c = comm.get(nb); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
      if (!counts.size) continue;
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best !== comm.get(n.id)) { comm.set(n.id, best); changed = true; }
    }
    if (!changed) break;
  }
  for (const n of nodes) o.db.prepare('UPDATE nodes SET properties=? WHERE id=?')
    .run(JSON.stringify({ ...n.properties, community: comm.get(n.id) }), n.id);
  return { count: new Set(comm.values()).size };
}

/** Build/refresh the concept graph: embed new/changed nodes (bounded) + recompute communities.
 *  Deterministic + offline-safe (uses the embedder's fallback when LLM is off). */
export async function refreshConceptGraph(o, { maxEmbedPerPass } = {}) {
  const rc = o.cfg.conceptRouting || {};
  if (rc.enabled === false) return { skipped: true, reason: 'disabled' };
  const cap = maxEmbedPerPass ?? rc.maxEmbedPerPass ?? 60;
  const nodes = o.graph.allNodes();
  let embedded = 0;
  for (const n of nodes) {
    if (embedded >= cap) break;
    const digest = nodeDigest(o.db, n);
    const h = sha12(digest);
    if (n.properties?.embDigestHash === h && Array.isArray(n.properties?.embedding)) continue; // unchanged
    const { vector } = await o.embedder.embed(digest);
    o.db.prepare('UPDATE nodes SET properties=?, updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...n.properties, embedding: vector, embDigestHash: h }), nowISO(), n.id);
    embedded++;
  }
  const communities = detectCommunities(o);
  return { nodes: nodes.length, embedded, communities: communities.count };
}

/**
 * Hot-path concept routing: from the query vector, find the nearest concept nodes, expand to their
 * communities, and return the set of active entry ids linked to those concepts. Fail-soft: empty set
 * if nothing is embedded. Pure (reads db only) so retrieval can call it with the vector it already has.
 */
export function conceptSeedsFromVector(db, qv, cfg = {}) {
  const rc = cfg.conceptRouting || {};
  if (rc.enabled === false || !qv) return new Set();
  const rows = db.prepare('SELECT id,label,properties FROM nodes').all()
    .map((r) => ({ id: r.id, label: r.label, props: json(r.properties, {}) }))
    .filter((n) => Array.isArray(n.props.embedding) && n.props.embedding.length === qv.length);
  if (!rows.length) return new Set();
  const ranked = rows.map((n) => ({ n, sim: cosine(qv, n.props.embedding) }))
    .sort((a, b) => b.sim - a.sim).slice(0, rc.topConcepts ?? 5)
    .filter((x) => x.sim > (rc.minSim ?? 0.1));
  if (!ranked.length) return new Set();
  const topIds = new Set(ranked.map((x) => x.n.id));
  const communities = new Set(ranked.map((x) => x.n.props.community).filter(Boolean));
  const labels = new Set();
  for (const n of rows) if (topIds.has(n.id) || communities.has(n.props.community)) labels.add(n.label.toLowerCase());
  const seeds = new Set();
  for (const e of db.prepare("SELECT id,concepts FROM entries WHERE status='active'").all()) {
    const cs = json(e.concepts, []);
    if (Array.isArray(cs) && cs.some((c) => labels.has(String(c.name || '').toLowerCase()))) seeds.add(e.id);
  }
  return seeds;
}
