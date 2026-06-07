/**
 * ClaimStore — Synthadoc-style claim provenance, in state.db.
 * Round-trips losslessly (the scaffold serialized the chain to prose then
 * regex-parsed it back). Provenance + chain stored as JSON.
 */
import { genId, nowISO, json, tokenize } from './util.mjs';

const STATUSES = new Set(['active', 'verified', 'contradicted', 'superseded', 'archived']);

export class ClaimStore {
  constructor(db) { this.db = db; }

  add({ content, type = 'fact', source = {}, provenance = {}, metadata = {} }) {
    const id = genId('claim', content.slice(0, 50) + (source.path || ''));
    const ts = nowISO();
    const prov = {
      extractedAt: provenance.extractedAt || ts,
      extractor: provenance.extractor || 'unknown',
      confidence: provenance.confidence ?? 0.5,
      chain: provenance.chain || [{ step: 'ingest', source: source.path || 'unknown', timestamp: ts }],
    };
    this.db.prepare(`
      INSERT INTO claims(id,content,type,source,provenance,status,metadata,created_at,updated_at)
      VALUES(?,?,?,?,?, 'active', ?,?,?)
    `).run(id, content, type, JSON.stringify(source), JSON.stringify(prov), JSON.stringify(metadata), ts, ts);
    return this.get(id);
  }

  get(id) { const r = this.db.prepare('SELECT * FROM claims WHERE id=?').get(id); return r ? this.#h(r) : null; }
  getAll() { return this.db.prepare('SELECT * FROM claims ORDER BY created_at DESC').all().map((r) => this.#h(r)); }

  updateStatus(id, status) {
    if (!STATUSES.has(status)) throw new Error(`bad status: ${status}`);
    this.db.prepare('UPDATE claims SET status=?, updated_at=? WHERE id=?').run(status, nowISO(), id);
  }

  search(query, { types = [], statuses = [], limit = 50 } = {}) {
    const qt = tokenize(query);
    return this.getAll()
      .filter((c) => (!types.length || types.includes(c.type)) && (!statuses.length || statuses.includes(c.status)))
      .map((c) => ({ c, score: this.#score(c, qt) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.c);
  }

  stats() {
    const all = this.getAll();
    const byType = {}, byStatus = {};
    for (const c of all) { byType[c.type] = (byType[c.type] || 0) + 1; byStatus[c.status] = (byStatus[c.status] || 0) + 1; }
    return { total: all.length, byType, byStatus };
  }

  #score(c, qt) {
    const hay = (c.content + ' ' + (c.source?.path || '')).toLowerCase();
    let s = 0;
    for (const t of qt) if (hay.includes(t)) s++;
    return s;
  }

  #h(r) { return { ...r, source: json(r.source, {}), provenance: json(r.provenance, {}), metadata: json(r.metadata, {}) }; }
}
