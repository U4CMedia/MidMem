/**
 * Orchestrator — the single coordinator. Every mutating op is gated by governance;
 * all state lives in state.db; retrieval is hybrid; the vault is a projection.
 */
import * as fs from 'node:fs/promises';
import { StateDB } from './db.mjs';
import { loadConfig } from './config.mjs';
import { TieredMemory } from './memory.mjs';
import { Embedder } from './embeddings.mjs';
import { Extractor } from './extract.mjs';
import { GraphStore } from './graph.mjs';
import { ClaimStore } from './claims.mjs';
import { SigmaVerifier } from './verify.mjs';
import { PolicyEvaluator, governed } from './governance.mjs';
import { projectVault } from './project.mjs';
import { hybridSearch } from './retrieval.mjs';
import { makeVectorStore } from './vectorstore.mjs';
import { genId, sha12, nowISO } from './util.mjs';

export class Orchestrator {
  constructor(overrides = {}) {
    this.cfg = loadConfig(overrides);
    this.db = new StateDB(this.cfg.dbPath);
    this.vectorStore = makeVectorStore(this.cfg, this.db);
    this.memory = new TieredMemory(this.db, this.cfg, this.vectorStore);
    this.embedder = new Embedder(this.cfg);
    this.extractor = new Extractor(this.cfg);
    this.graph = new GraphStore(this.db);
    this.claims = new ClaimStore(this.db);
    this.verifier = new SigmaVerifier(this.db, this.graph, this.cfg);
    this.gov = { evaluator: new PolicyEvaluator(this.cfg), db: this.db };
  }

  /** Ingest a raw source: extract → store (memory tier) → embed → graph → claims → verify. */
  async ingest({ path, type = 'note', title, metadata = {}, curated = false, scope = this.cfg.agentScope }) {
    return governed(this.gov, 'ingest', { path, type, scope, curated }, async () => {
      const text = await fs.readFile(path, 'utf8');
      const hash = sha12(text);
      // Hash-dedup: re-ingesting an unchanged file is a no-op (makes the bridge/cron idempotent).
      const dup = this.db.prepare('SELECT id FROM sources WHERE hash=?').get(hash);
      if (dup) { this.db.logOp('ingest-skip', { path, hash, sourceId: dup.id }); return { success: true, skipped: true, reason: 'unchanged', sourceId: dup.id }; }
      const sourceId = genId('src', path);
      this.db.prepare('INSERT INTO sources(id,path,type,title,hash,ingested_at,metadata) VALUES(?,?,?,?,?,?,?)')
        .run(sourceId, path, type, title || null, hash, nowISO(), JSON.stringify(metadata));

      const ex = await this.extractor.extract(text, type);
      const prov = { originalSource: path, extractedAt: nowISO(), chain: [{ step: 'ingest', source: path }] };
      const stored = this.db.tx(() =>
        this.memory.store({ content: ex.summary, type: 'ingest', tier: 'memory', scope, sourceId, provenance: prov, concepts: ex.concepts }));
      const { vector, model, mode } = await this.embedder.embed(ex.summary);
      await this.memory.upsertVector(stored.id, vector, model, mode);

      const nodeIds = ex.concepts.map((c) => this.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: path, properties: { confidence: c.confidence } }));
      for (let i = 1; i < nodeIds.length; i++) this.graph.upsertEdge({ from: nodeIds[0], to: nodeIds[i], type: 'relates', source: path });
      for (const cl of ex.claims) this.claims.add({ content: cl.content, type: 'fact', source: { path, type, title }, provenance: { extractor: ex.mode, confidence: cl.confidence } });

      const verification = this.verifier.verifyConcepts(ex.concepts);
      this.db.logOp('ingest', { path, entry: stored.id, concepts: ex.concepts.length, claims: ex.claims.length, mode: ex.mode, conflicts: verification.conflicts.length });
      return { success: true, entry: stored, concepts: ex.concepts.length, claims: ex.claims.length, verification, mode: ex.mode };
    });
  }

  /** The MCP `remember` op — store a memory directly. */
  async storeMemory({ content, type = 'insight', tier = 'memory', scope = this.cfg.agentScope, source, concepts, curated = false }) {
    return governed(this.gov, 'store', { tier, scope, curated }, async () => {
      const prov = source ? { originalSource: source.path, extractedAt: nowISO(), chain: [{ step: 'remember', source: source.path }] } : null;
      const stored = this.db.tx(() => this.memory.store({ content, type, tier, scope, provenance: prov, concepts }));
      const { vector, model, mode } = await this.embedder.embed(content);
      await this.memory.upsertVector(stored.id, vector, model, mode);
      if (concepts) for (const c of concepts) this.graph.upsertNode({ type: c.type || 'concept', label: c.name, source: 'remember' });
      this.db.logOp('remember', { entry: stored.id, tier });
      return { success: true, ...stored };
    });
  }

  async query(question, opts = {}) {
    const scopes = opts.scopes || this.#defaultScopes();
    const results = await hybridSearch(this.db, this.memory, this.embedder, question, { ...opts, scopes });
    this.memory.recordRetrieval(results.map((r) => r.id)); // usage signal feeds trust/decay
    const graphContext = opts.includeGraphContext ? this.#graphContext(question) : null;
    return { query: question, results, scopes, graphContext, tiers: opts.tiers || this.memory.tierNames, timestamp: nowISO() };
  }

  /** Feedback loop — caller marks a recalled entry helpful/unhelpful (nudges trust_score). */
  feedback(id, helpful = true) { const r = this.memory.recordFeedback(id, helpful); this.db.logOp('feedback', { id, helpful }); return r; }

  /** Reads default to this agent's own scope plus the shared commons. */
  #defaultScopes() { return [...new Set([this.cfg.agentScope, 'shared'])]; }

  recall(id) { return this.memory.get(id); }

  brief() {
    const g = this.graph.getGraph();
    return {
      tiers: this.memory.stats(),
      claims: this.claims.stats(),
      graph: { nodes: g.nodes.length, edges: g.edges.length },
      vectors: this.memory.vectorHealth(),
      recent: this.db.prepare('SELECT ts,operation FROM log ORDER BY id DESC LIMIT 10').all(),
    };
  }

  lint() {
    const conflicts = this.verifier.detectConflicts();
    const g = this.graph.getGraph();
    const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]));
    const orphans = g.nodes.filter((n) => !linked.has(n.id)).map((n) => n.label);
    return { contradictions: conflicts.conflicts, orphans, summary: { nodes: g.nodes.length, edges: g.edges.length, entries: Object.values(this.memory.stats()).reduce((a, b) => a + b, 0) } };
  }

  async forget(id, { soft = true, force = false } = {}) {
    return governed(this.gov, 'forget', { soft, force }, async () => { const r = await this.memory.forget(id, { soft }); this.db.logOp('forget', { id, soft }); return r; });
  }

  archive(opts = {}) { const r = this.memory.archive(opts); this.db.logOp('archive', r); return r; }

  async promote(id, toTier, { curated = false } = {}) {
    return governed(this.gov, 'promote', { toTier, curated }, () => { const r = this.memory.promote(id, toTier); this.db.logOp('promote', { id, toTier }); return r; });
  }

  project() { const r = projectVault(this.db, this.memory, this.graph, this.cfg); this.db.logOp('project', r); return r; }

  getGraph() { return this.graph.getGraph(); }
  searchClaims(q, opts) { return this.claims.search(q, opts); }

  #graphContext(q) {
    const nodes = this.graph.findByText(q);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = nodes.flatMap((n) => this.graph.neighbors(n.id)).filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes: nodes.map((n) => ({ id: n.id, label: n.label, type: n.type })), edges: edges.map((e) => ({ from: e.from, to: e.to, type: e.type })) };
  }

  close() { this.db.close(); }
}
