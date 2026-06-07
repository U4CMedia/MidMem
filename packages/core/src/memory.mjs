/**
 * TieredMemory — fact → memory → wisdom store, backed entirely by state.db.
 * No parallel markdown store (the vault is a downstream projection).
 */
import { genId, nowISO, json } from './util.mjs';

export class TieredMemory {
  /** @param {import('./db.mjs').StateDB} db @param {object} cfg */
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.tierNames = cfg.tiers.map((t) => t.name);
  }

  tier(name) { return this.cfg.tiers.find((t) => t.name === name); }

  /**
   * Store an entry (single transactional write to entries; vector set separately).
   * @returns {{id:string, rowid:number, tier:string}}
   */
  store({ content, type = 'note', tier = 'memory', scope = 'shared', sourceId = null, provenance = null, concepts = null }) {
    const tc = this.tier(tier);
    if (!tc) throw new Error(`unknown tier: ${tier}`);
    const id = genId(tier, content.slice(0, 80) + type + Date.now());
    const ts = nowISO();
    const expiresAt = tc.ttl ? new Date(Date.now() + tc.ttl).toISOString() : null;
    const info = this.db.prepare(`
      INSERT INTO entries(id,tier,type,content,source_id,provenance,concepts,status,scope,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?, 'active', ?,?,?,?)
    `).run(id, tier, type, content, sourceId,
      provenance ? JSON.stringify(provenance) : null,
      concepts ? JSON.stringify(concepts) : null, scope, ts, ts, expiresAt);
    return { id, rowid: Number(info.lastInsertRowid), tier, scope };
  }

  upsertVector(entryId, embedding, model) {
    this.db.prepare(`
      INSERT INTO vectors(entry_id,dim,embedding,model,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET dim=excluded.dim, embedding=excluded.embedding, model=excluded.model
    `).run(entryId, embedding.length, JSON.stringify(embedding), model, nowISO());
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    return r ? this.#hydrate(r) : null;
  }

  /** Active entries, optionally filtered by tier and scope. */
  listActive({ tiers = this.tierNames, scopes = null } = {}) {
    const conds = ["status='active'", `tier IN (${tiers.map(() => '?').join(',')})`];
    const params = [...tiers];
    if (scopes && scopes.length) { conds.push(`scope IN (${scopes.map(() => '?').join(',')})`); params.push(...scopes); }
    return this.db.prepare(`SELECT * FROM entries WHERE ${conds.join(' AND ')}`).all(...params).map((r) => this.#hydrate(r));
  }

  /** Map of rowid → entry for a tier/scope set (used by retrieval to join FTS hits). */
  rowidMap(tiers = this.tierNames, scopes = null) {
    const m = new Map();
    for (const e of this.listActive({ tiers, scopes })) m.set(e.rowid, e);
    return m;
  }

  /** Vectors for active entries in the given tiers/scopes: [{id, tier, vector}]. */
  activeVectors(tiers = this.tierNames, scopes = null) {
    const conds = ["e.status='active'", `e.tier IN (${tiers.map(() => '?').join(',')})`];
    const params = [...tiers];
    if (scopes && scopes.length) { conds.push(`e.scope IN (${scopes.map(() => '?').join(',')})`); params.push(...scopes); }
    return this.db.prepare(`
      SELECT v.entry_id id, e.tier tier, v.embedding emb
      FROM vectors v JOIN entries e ON e.id = v.entry_id
      WHERE ${conds.join(' AND ')}
    `).all(...params).map((r) => ({ id: r.id, tier: r.tier, vector: json(r.emb, []) }));
  }

  promote(id, toTier) {
    if (!this.tier(toTier)) throw new Error(`unknown tier: ${toTier}`);
    const r = this.db.prepare('SELECT id FROM entries WHERE id=?').get(id);
    if (!r) return { success: false, message: `not found: ${id}` };
    this.db.prepare("UPDATE entries SET tier=?, status='promoted', updated_at=? WHERE id=?")
      .run(toTier, nowISO(), id);
    // re-activate in the new tier (promoted marks the lifecycle event; keep searchable)
    this.db.prepare("UPDATE entries SET status='active' WHERE id=?").run(id);
    return { success: true, message: `promoted ${id} → ${toTier}` };
  }

  forget(id, { soft = true } = {}) {
    const r = this.db.prepare('SELECT id FROM entries WHERE id=?').get(id);
    if (!r) return { success: false, message: `not found: ${id}` };
    if (soft) {
      this.db.prepare("UPDATE entries SET status='deleted', updated_at=? WHERE id=?").run(nowISO(), id);
    } else {
      this.db.prepare('DELETE FROM vectors WHERE entry_id=?').run(id);
      this.db.prepare('DELETE FROM entries WHERE id=?').run(id);
    }
    return { success: true, message: `${soft ? 'soft-' : ''}deleted ${id}` };
  }

  archive({ olderThanMs = 30 * 864e5, tiers = this.tierNames } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const ph = tiers.map(() => '?').join(',');
    const info = this.db.prepare(`
      UPDATE entries SET status='archived', updated_at=? WHERE status='active' AND updated_at < ? AND tier IN (${ph})
    `).run(nowISO(), cutoff, ...tiers);
    return { archived: info.changes, message: `archived ${info.changes} entries` };
  }

  stats() {
    const rows = this.db.prepare("SELECT tier, COUNT(*) c FROM entries WHERE status='active' GROUP BY tier").all();
    const out = {};
    for (const t of this.tierNames) out[t] = 0;
    for (const r of rows) out[r.tier] = r.c;
    return out;
  }

  #hydrate(r) {
    return {
      ...r, rowid: Number(r.rowid),
      provenance: json(r.provenance), concepts: json(r.concepts),
    };
  }
}
