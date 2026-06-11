# OpenClaw Middleware — LLM Wiki Knowledge Router

A self-contained **LLM Wiki middleware layer**: a single source-of-truth knowledge store with
**hybrid retrieval (lexical + vector)**, tiered memory, a typed knowledge graph, claim
provenance, **fail-closed governance**, and an Obsidian projection — exposed to LLM agents over
the **Model Context Protocol (MCP)**, a CLI, and a programmatic API.

It is the broker between AI agents and their knowledge: agents `ingest`, `query`, and `remember`
through the router; the knowledge store sits *behind* it. Built for the OpenClaw + Hermes
dual-stack, but usable by **either system alone or both together** (see [Integration](#integration)).

> **Status:** foundation + cross-agent scope + native→middleware bridge + retrieval upgrades
> (trust, trigram, token-budget, graph-boost, dim-guard) + selectable Qdrant vector backend +
> hand-off memory gate. Tested (smoke **27/27**). Runnable Node ESM, **zero external dependencies**
> (Node ≥ 22.5 built-ins only: `node:sqlite`, `crypto`, `fetch`).
> `packages/core/` is the active foundation; the other `packages/*` are the superseded interim
> scaffold, kept for reference only.

---

## Why

A single always-loaded memory file does not scale — it taxes every turn's context window. This
middleware decouples **capacity** from per-turn context: agents hold a tiny canonical index and
pull the relevant slice **on demand** via hybrid retrieval from an unbounded, shared store.

## Architecture

```
sources ──ingest──► LLM extract (concepts/claims/embeddings) ─┐  (deterministic offline fallback)
                                                              ▼ transactional write
        ┌───────────────────── state.db  (SINGLE source of truth) ─────────────────────┐
        │ entries · entries_fts (FTS5/BM25) · vectors · nodes · edges · claims · log    │
        └───────────────────────────────────────────────────────────────────────────────┘
              │ project (LLM-owned)                ▲ verify (deterministic, one graph)
              ▼                                    │
        Obsidian vault (projection)  ── query: FTS5 ⊕ trigram ⊕ vector (RRF) + trust/graph boosts ──►
              ▲                                    │
              └──────────── MCP server (12 tools) ─┴──► OpenClaw / Hermes
```

- **`state.db` is the source of truth**; the markdown vault is a deterministic projection of it.
- **Hybrid retrieval**: SQLite FTS5/BM25 (token lexical) ⊕ FTS5-trigram (substring lexical) ⊕ vector
  cosine (semantic), fused via Reciprocal Rank Fusion, plus trust + graph ref-chain boosts and an
  optional token budget. Vectors are incremental — lexical works standalone.
- **Vector backend is pluggable**: `sqlite` (in-DB JSON cosine, zero-dep, default) or `qdrant` (external ANN).
- **Tiers**: `fact` (raw, 7d TTL) → `memory` (synthesized, 30d) → `wisdom` (curated, ∞), with trust scoring.
- **Scope**: every entry is `openclaw` | `hermes` | `shared` — private working memory + a shared commons.
- **Hand-off gate ("firstware")**: pushes a memory brief into an agent hand-off so the receiver can't overlook it.

---

## Abstraction layers

The middleware is composed of swappable layers. **Required** layers must be present to function as
an LLM Wiki middleware; **recommended** layers add capability and are safe to defer.

| Layer | Module | Required? | Purpose | Swap / configure |
|---|---|---|---|---|
| **Integration / transport** | `bin/mcp-server.mjs` (MCP stdio) · `bin/cli.mjs` · `src/orchestrator.mjs` (API) | **Required** | The contract agents speak. MCP is primary; CLI + API are alternates. | register per stack (below) |
| **Store** | `src/db.mjs` (`state.db`) | **Required** | Single source of truth + unified index. | `OCMW_DB_PATH`; move to a shared path/NAS |
| **Retrieval** | `src/retrieval.mjs` | **Required** | Hybrid FTS5 ⊕ trigram ⊕ vector (RRF) + trust/graph boosts + token budget. | `fusionWeights`, `rrfK`, `trustWeight` |
| **Vector store** | `src/vectorstore.mjs` | **Required** | Pluggable ANN: `sqlite` (default) \| `qdrant`. Holds id→vector; `state.db` keeps metadata. | `OCMW_VECTOR_BACKEND`, `OCMW_QDRANT_URL` |
| **Embedding** | `src/embeddings.mjs` | **Required\*** | Vectors for the semantic lane + dimension guard. *Deterministic fallback if no model.* | `OCMW_EMBED_MODEL`, `OCMW_LLM_ENDPOINT` |
| **Governance** | `src/governance.mjs` | **Required** | Fail-closed policy gating on every mutation. | extend `defaultPolicies()` |
| **Tiered memory** | `src/memory.mjs` | Recommended | fact→memory→wisdom lifecycle (TTL, promote, archive). | `tiers` in config |
| **Extraction** | `src/extract.mjs` | Recommended | LLM concept/claim extraction. *Heuristic fallback.* | `OCMW_EXTRACT_MODEL` |
| **Graph** | `src/graph.mjs` | Recommended | Typed entities/edges; wikilinks; graph-context. | — |
| **Claims / provenance** | `src/claims.mjs` | Recommended | Synthadoc-style claim audit trail. | — |
| **Verification** | `src/verify.mjs` | Recommended | Deterministic contradiction/identity checks. | `sigmaStrictMode` |
| **Projection** | `src/project.mjs` | Recommended | Render `state.db` → Obsidian markdown. | `OBSIDIAN_VAULT_PATH`, `WIKI_PATH` |
| **Scope** | (in store/retrieval/governance) | Required *for dual*, else optional | Multi-agent private + shared partitioning. | `OCMW_AGENT_SCOPE` |
| **Bridge** | `src/bridge.mjs` (`ocmw bridge`) | Recommended | Pull each stack's flat native memory into the store. | `bridgeSources` |
| **Trust / feedback** | (memory + retrieval) | Recommended | `trust_score` + usage/`feedback` loop; boosts ranking. | `trustWeight`, `feedback` tool |
| **Hand-off gate** | `src/handoff.mjs` (`handoff_brief`) | Recommended | Push a scoped memory brief into an agent hand-off (firstware). | profiles `local` / `frontier` |

\* The embedding layer is required for semantic recall, but the system **runs without a live model**
via a deterministic hash embedder (lexical retrieval still works). Load a real model before
production ingest so vectors are semantically meaningful.

---

## Integration

The middleware speaks MCP, so any MCP-capable agent can use it. Three supported topologies:

### Option A — OpenClaw only (1:1)
Register the MCP server in OpenClaw; it's the sole consumer. A single agent needs no scope
partitioning, so use `OCMW_AGENT_SCOPE=shared`.

```bash
openclaw mcp set middleware-memory '{
  "command": "node",
  "args": ["/path/to/openclaw-middleware/packages/core/bin/mcp-server.mjs"],
  "env": {
    "OCMW_DB_PATH": "/path/to/openclaw-middleware/state.db",
    "OBSIDIAN_VAULT_PATH": "/path/to/vault",
    "WIKI_PATH": "LLM Wiki",
    "OCMW_LLM_ENDPOINT": "http://localhost:1234/v1",
    "OCMW_EMBED_MODEL": "bge-m3",
    "OCMW_AGENT_SCOPE": "shared"
  }
}'
```

### Option B — Hermes only (1:1)
Register in `~/.hermes/config.yaml`; Hermes is the sole consumer. `OCMW_AGENT_SCOPE=shared`.

```yaml
mcp_servers:
  middleware-memory:
    command: node
    args:
      - /path/to/openclaw-middleware/packages/core/bin/mcp-server.mjs
    env:
      OCMW_DB_PATH: /path/to/openclaw-middleware/state.db
      OBSIDIAN_VAULT_PATH: /path/to/vault
      WIKI_PATH: LLM Wiki
      OCMW_LLM_ENDPOINT: http://localhost:1234/v1
      OCMW_EMBED_MODEL: bge-m3
      OCMW_AGENT_SCOPE: shared
```

### Option C — Dual integration (OpenClaw + Hermes, shared store)
Register in **both**, pointing at the **same `OCMW_DB_PATH`** — one shared knowledge store. Set a
**distinct `OCMW_AGENT_SCOPE` per stack** (`openclaw` / `hermes`) so each gets private working
memory plus the shared commons:

- OpenClaw registration: `OCMW_AGENT_SCOPE=openclaw`
- Hermes registration: `OCMW_AGENT_SCOPE=hermes`

Behavior: writes default to the caller's scope; reads return the caller's scope **+ `shared`**;
publish cross-agent knowledge with `scope: "shared"`. Governance blocks an agent from writing the
other's private scope. Concurrency across the two server processes is handled by SQLite WAL +
`busy_timeout`. (This is the current OpenDuck deployment.)

| | Option A | Option B | Option C |
|---|---|---|---|
| Consumers | OpenClaw | Hermes | both |
| `OCMW_AGENT_SCOPE` | `shared` | `shared` | `openclaw` / `hermes` |
| Private + shared memory | — | — | ✅ |
| Shared `state.db` | n/a | n/a | ✅ (same path) |

---

## Quick start

```bash
# No install needed (Node ≥ 22.5 built-ins only).
cd packages/core
node test/smoke.mjs                         # end-to-end self-test (offline) → 27/27

node bin/cli.mjs init                        # show resolved config
node bin/cli.mjs ingest <file> --type note   # compile a source into the store
node bin/cli.mjs query "..." --graph         # hybrid query (+ graph context, --maxTokens budget)
node bin/cli.mjs remember "..." --scope shared
node bin/cli.mjs brief                        # tier/claim/graph + vector-health counts
node bin/cli.mjs project                      # render the Obsidian vault
node bin/cli.mjs bridge                       # pull native agent memory into the store
node bin/cli.mjs handoff "<task>" --profile local|frontier   # build a hand-off memory brief
```

### MCP tools (12)
`ingest` · `query` · `remember` · `recall` · `brief` · `audit` · `forget` · `archive` ·
`promote` · `project` · `feedback` (trust) · `handoff_brief` (memory gate)

**Hand-off memory gate ("firstware"):** `handoff_brief` builds a scoped, token-budgeted memory brief
to inject into an agent hand-off (e.g. before an ACP spawn, which doesn't share context) so the
receiving model can't overlook prior knowledge. Two profiles: **`local`** (small models — tight,
authoritative, push-only) and **`frontier`** (cloud models — richer, provenance + ids, push-brief +
pull-depth). The gate *calls* the store; it doesn't replace it (firstware-on-middleware).

### Configuration (env)
| Var | Default | Purpose |
|---|---|---|
| `OCMW_DB_PATH` | `<repo>/state.db` | Single source-of-truth DB |
| `OBSIDIAN_VAULT_PATH` | `~/Obsidian` | Vault root (projection target) |
| `WIKI_PATH` | `LLM Wiki` | Wiki subfolder in the vault |
| `OCMW_LLM_ENDPOINT` | `http://localhost:1234/v1` | OpenAI-compatible endpoint (embed + extract) |
| `OCMW_EMBED_MODEL` | `bge-m3` | Embedding model (load it in your server) |
| `OCMW_VECTOR_BACKEND` | `sqlite` | Vector store: `sqlite` (in-DB, zero-dep) or `qdrant` |
| `OCMW_QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint (when backend=qdrant) |
| `OCMW_EXTRACT_MODEL` | (chat model) | Extraction model |
| `OCMW_AGENT_SCOPE` | `shared` | This consumer's scope: `openclaw`/`hermes`/`shared` |
| `OCMW_LLM_ENABLED` | `1` | Set `0` to force offline/deterministic fallbacks |
| `OCMW_SOURCE_ROOTS` | repo/workspace/vault dirs | Allowed ingest roots (path-traversal guard) |

---

## Recommended embedding model
`BAAI/bge-m3` (1024-dim, 8192-ctx, hybrid dense+sparse) — best fit for hybrid wiki RAG and Qdrant.
Lighter alternative: `nomic-embed-text-v1.5` (768-dim). Pick one **before first ingest** and keep
it across any vector-store migration (no re-embedding; the dimension guard enforces consistency).

## Roadmap
- Vector store → **Qdrant** (decided over ChromaDB; `OCMW_VECTOR_BACKEND=qdrant`, adapter built — validate against a live instance).
- Vault → **NAS share** (change `OBSIDIAN_VAULT_PATH` only).
- **Decay scanner + semantic near-dup report** (memory-os borrows; need the embed model loaded first).
- **Fine-tuned-LLM `wisdom` tier** trained from curated wisdom (weight-space long-term memory).
- Pre-LLM-call memory gate (per-turn brief, sibling to the hand-off gate); TypeScript migration; bidirectional vault sync.

## Repository layout
```
packages/core/         # ← active foundation (this README describes it)
  src/                 # db, memory, retrieval, vectorstore, embeddings, extract, graph, claims,
                       # verify, governance, project, bridge, handoff, orchestrator, config
  bin/                 # cli.mjs, mcp-server.mjs
  test/smoke.mjs       # end-to-end self-test
packages/{orchestrator,tiered-memory,obsidian-bridge,sigma-verifier,mcp-memory}/
                       # legacy interim scaffold — reference only, superseded by core
wiki/ memory/ graph/ claims/ audit/ config/   # scaffold-era dirs (vault is now external)
```

## License
MIT
