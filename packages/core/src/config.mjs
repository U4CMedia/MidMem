/**
 * Configuration for the rebuilt middleware core.
 *
 * Single source-of-truth lives in `state.db`; the Obsidian vault is a projection.
 * All paths/endpoints overridable via env so OpenClaw/Hermes can point at the
 * same db without code changes.
 */

import * as path from 'node:path';
import * as os from 'node:os';

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
/** Obsidian vault root. Local now; will repoint at the Unraid share later (env-only change).
 *  Layout: `<vault>/LLM Wiki` (projected from state.db) · `<vault>/OpenClaw` · `<vault>/Hermes`. */
const VAULT = process.env.OBSIDIAN_VAULT_PATH || path.join(HOME, 'Obsidian');

/** @typedef {'fact'|'memory'|'wisdom'} Tier */

/**
 * Tier model (Core-LLM-Wiki inspired): fact (raw) → memory (synthesized) → wisdom (curated).
 * TTL in ms (0 = never). `autoPromote` marks tiers whose aged entries are promotion
 * candidates. `curatedOnly` tiers are governance-gated (no uncurated writes).
 */
export const DEFAULT_TIERS = [
  { name: 'fact', description: 'Raw, unprocessed knowledge from sources', ttl: 7 * 864e5, autoPromote: true, curatedOnly: false },
  { name: 'memory', description: 'Synthesized knowledge with context', ttl: 30 * 864e5, autoPromote: true, curatedOnly: false },
  { name: 'wisdom', description: 'Curated, verified knowledge (future fine-tune training set)', ttl: 0, autoPromote: false, curatedOnly: true },
];

export function loadConfig(overrides = {}) {
  const cfg = {
    /** Single SQLite source-of-truth. */
    dbPath: process.env.OCMW_DB_PATH || path.join(REPO, 'state.db'),
    /** Obsidian vault root (LLM-owned wiki projected into the `wikiPath` subfolder). */
    vaultPath: VAULT,
    /** Wiki subdir inside the vault — the projected, LLM-owned knowledge base. */
    wikiPath: process.env.WIKI_PATH || 'LLM Wiki',
    /** Agent-owned vault folders (human-readable in Obsidian; also ingest source roots). */
    openclawPath: process.env.OPENCLAW_VAULT_DIR || 'OpenClaw',
    hermesPath: process.env.HERMES_VAULT_DIR || 'Hermes',
    /** Raw sources allowed for ingest (path-traversal guard in governance).
     *  Agents drop research into their vault folder; the router ingests it into the wiki.
     *  ~/changelog = frozen quarterly CHANGELOG archives (ingested once at archive time;
     *  the live root CHANGELOG.md stays QMD-only — too churny for one-summary-per-version). */
    sourceRoots: (process.env.OCMW_SOURCE_ROOTS ||
      [REPO, `${HOME}/.openclaw/workspace`, `${HOME}/.hermes/memories`, `${HOME}/changelog`, path.join(VAULT, 'OpenClaw'), path.join(VAULT, 'Hermes')].join(';')
    ).split(';').filter(Boolean),
    /** Native→middleware bridge: dirs scanned by `bridgeMemory`, each tagged with a scope.
     *  Pulls each stack's flat memory into the shared, tiered, searchable store. */
    bridgeSources: [
      { dir: path.join(HOME, '.openclaw', 'workspace', 'memory'), scope: 'openclaw', type: 'session' },
      { dir: path.join(HOME, '.hermes', 'memories'), scope: 'hermes', type: 'note' },
      { dir: path.join(VAULT, 'OpenClaw'), scope: 'openclaw', type: 'note' },
      { dir: path.join(VAULT, 'Hermes'), scope: 'hermes', type: 'note' },
    ],
    /** LM Studio OpenAI-compatible endpoint (embeddings + extraction). */
    llmEndpoint: process.env.OCMW_LLM_ENDPOINT || 'http://192.168.50.210:1234/v1',
    embedModel: process.env.OCMW_EMBED_MODEL || 'nomic-embed-text',
    extractModel: process.env.OCMW_EXTRACT_MODEL || 'qwen/qwen3.6-35b-a3b',
    /** Allow network LLM calls; when false, deterministic offline fallbacks are used. */
    llmEnabled: process.env.OCMW_LLM_ENABLED !== '0',
    /** Per-call timeout for LLM (ms) — the local model can saturate; keep tight. */
    llmTimeoutMs: Number(process.env.OCMW_LLM_TIMEOUT_MS || 20000),
    /** Hybrid fusion: RRF constant + per-lane weights (fts token, trigram substring, vector). */
    rrfK: 60,
    fusionWeights: { fts: 1.0, trigram: 0.5, vector: 1.0 },
    /** Additive ranking boosts, kept small vs a single RRF rank (≈ 1/60 ≈ 0.0167). */
    trustWeight: 0.01, // × (trust_score − 0.5) → ±0.005
    graphBoost: 0.004, // × shared-concept count (capped at 3)
    /** Fallback embedding dimension when offline. */
    fallbackDim: 256,
    /** Vector backend: 'sqlite' (in-DB JSON cosine, zero-dep, default) or 'qdrant' (external ANN). */
    vectorBackend: process.env.OCMW_VECTOR_BACKEND || 'sqlite',
    qdrantUrl: process.env.OCMW_QDRANT_URL || 'http://localhost:6333',
    qdrantCollection: process.env.OCMW_QDRANT_COLLECTION || 'openduck_memory',
    qdrantApiKey: process.env.OCMW_QDRANT_API_KEY || '',
    tiers: DEFAULT_TIERS,
    /** Phase 1 trigger-less recall: pre-turn hook calls `proactiveRecall(message)` which self-gates
     *  on `minScore` and caps injection at `maxTokens`. minScore is conservative by default (skip
     *  unless a real match); it's the seam for later feedback-driven self-tuning. */
    proactiveRecall: {
      enabled: process.env.OCMW_PROACTIVE_RECALL !== '0',
      minScore: Number(process.env.OCMW_RECALL_MIN_SCORE || 0.02),
      maxTokens: Number(process.env.OCMW_RECALL_MAX_TOKENS || 600),
      maxItems: Number(process.env.OCMW_RECALL_MAX_ITEMS || 4),
    },
    /** Self-driving lifecycle (decay + promotion) — runs opportunistically on normal use
     *  (query/ingest/remember), throttled by intervalMs, plus an external daily timer.
     *  Decay: expired leases archived; retrieval renews an entry's lease (decay-by-disuse);
     *  repeatedly-unhelpful entries (trust < distrustBelow) archived. Promotion: fact→memory
     *  on usage alone; memory→wisdom only when EARNED via explicit helpful feedback (that
     *  feedback is the curation signal — the curated-only gate stays meaningful). */
    maintenance: {
      enabled: process.env.OCMW_MAINTENANCE !== '0',
      intervalMs: Number(process.env.OCMW_MAINT_INTERVAL_MS || 3600e3), // lazy sweep ≤ 1/hour
      refreshOnAccess: true, // retrieval extends expires_at by the tier's TTL
      distrustBelow: 0.2, // archive non-permanent entries the feedback loop has buried
      factPromote: { minRetrievals: 3, minTrust: 0.6 }, // fact→memory: proven useful by use
      wisdomPromote: { minRetrievals: 5, minTrust: 0.7, minHelpful: 2 }, // memory→wisdom: earned curation
    },
    /** Default memory scope for this process: `openclaw` | `hermes` | `shared`.
     *  Set per MCP registration (OCMW_AGENT_SCOPE). Writes default here; reads = this + shared.
     *  `shared` = admin/bridge context (may write any scope). */
    agentScope: process.env.OCMW_AGENT_SCOPE || 'shared',
    /** Governance: deny on policy-eval error (fail-closed). */
    failClosed: true,
  };
  return { ...cfg, ...overrides };
}

export const REPO_ROOT = REPO;
