/**
 * Vector store abstraction — pluggable ANN backend.
 *
 * `state.db` remains the source of truth for ALL metadata (tier/scope/status/trust);
 * the vector store holds only `entry_id → embedding` and returns similarity-ranked ids.
 * Retrieval then filters those ids against the live `entries` table. This keeps the two
 * backends symmetric and avoids payload/status sync.
 *
 *  - `sqlite`  : vectors as JSON in state.db + JS cosine. Zero-dep, default.
 *  - `qdrant`  : external Qdrant (REST). Dense cosine collection. ⚠ PENDING LIVE VALIDATION.
 *
 * Interface (all async): upsert({id,embedding,model}) · delete(id) · search(vec,limit) → [{id,score}] · health()
 */
import { createHash } from 'node:crypto';
import { cosine, json, nowISO } from './util.mjs';

// ── SQLite backend (default) ────────────────────────────────────────────────
export class SqliteVectorStore {
  constructor(db) { this.db = db; this.backend = 'sqlite'; }

  async upsert({ id, embedding, model }) {
    this.db.prepare(`
      INSERT INTO vectors(entry_id,dim,embedding,model,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET dim=excluded.dim, embedding=excluded.embedding, model=excluded.model
    `).run(id, embedding.length, JSON.stringify(embedding), model, nowISO());
  }

  async delete(id) { this.db.prepare('DELETE FROM vectors WHERE entry_id=?').run(id); }

  async search(queryVector, limit = 400) {
    return this.db.prepare('SELECT entry_id id, embedding emb FROM vectors').all()
      .map((r) => ({ id: r.id, score: cosine(queryVector, json(r.emb, [])) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async health() {
    const byDim = this.db.prepare('SELECT dim, COUNT(*) c FROM vectors GROUP BY dim').all();
    const fallback = this.db.prepare("SELECT COUNT(*) c FROM vectors WHERE model LIKE 'fallback%'").get().c;
    return { backend: 'sqlite', byDim: Object.fromEntries(byDim.map((r) => [r.dim, r.c])), fallbackVectors: fallback };
  }
}

// Qdrant point ids must be uint64 or UUID; hash our string entry_id into a 52-bit safe int.
const pointId = (s) => parseInt(createHash('sha1').update(s).digest('hex').slice(0, 13), 16);

// ── Qdrant backend (external ANN) — ⚠ implemented against the REST API; validate against a
//    live instance before production use. Default OFF (OCMW_VECTOR_BACKEND=qdrant to enable). ──
export class QdrantVectorStore {
  constructor(cfg) {
    this.url = (cfg.qdrantUrl || 'http://localhost:6333').replace(/\/$/, '');
    this.collection = cfg.qdrantCollection || 'openduck_memory';
    this.apiKey = cfg.qdrantApiKey || '';
    this.backend = 'qdrant';
    this._ready = false;
  }

  async #req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    const res = await fetch(`${this.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`qdrant ${method} ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }

  async #ensure(dim) {
    if (this._ready) return;
    try { await this.#req('GET', `/collections/${this.collection}`); }
    catch { await this.#req('PUT', `/collections/${this.collection}`, { vectors: { size: dim, distance: 'Cosine' } }); }
    this._ready = true;
  }

  async upsert({ id, embedding }) {
    // Fail-soft: a down/misconfigured Qdrant must not block the state.db write (the source of
    // truth). The entry is still stored + lexically searchable; vectors index once Qdrant is up.
    try {
      await this.#ensure(embedding.length);
      await this.#req('PUT', `/collections/${this.collection}/points?wait=true`,
        { points: [{ id: pointId(id), vector: embedding, payload: { entry_id: id } }] });
    } catch (e) {
      if (!this._warned) { console.error(`[vectorstore:qdrant] upsert failed (${e.message}) — entries stored in state.db but not vector-indexed until Qdrant is reachable; check 'brief'.vectors`); this._warned = true; }
    }
  }

  async delete(id) {
    try { await this.#req('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: [pointId(id)] }); } catch {}
  }

  async search(queryVector, limit = 400) {
    try {
      const r = await this.#req('POST', `/collections/${this.collection}/points/search`,
        { vector: queryVector, limit, with_payload: true });
      return (r.result || []).map((p) => ({ id: p.payload?.entry_id || String(p.id), score: p.score }));
    } catch { return []; } // fail soft → lexical lanes still answer
  }

  async health() {
    try {
      const r = await this.#req('GET', `/collections/${this.collection}`);
      return { backend: 'qdrant', url: this.url, collection: this.collection, points: r.result?.points_count ?? null };
    } catch (e) { return { backend: 'qdrant', url: this.url, collection: this.collection, error: e.message }; }
  }
}

export function makeVectorStore(cfg, db) {
  return cfg.vectorBackend === 'qdrant' ? new QdrantVectorStore(cfg) : new SqliteVectorStore(db);
}
