# OpenClaw Middleware

Modular middleware layer bridging OpenClaw + Hermes with knowledge store, actions, history, logs, and long-term memory.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Layer                         │
│  (Chat management, cron jobs, heartbeat, messaging)        │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Middleware Layer   │
              │                      │
              │  Synto (ingest/obs)  │  ← Primary wiki engine
              │  Link (MCP/memory)   │  ← Agent memory
              │  Sigma-Guard (verify)│  ← Contradiction detection
              │  Core-LLM-Wiki       │  ← Tiered memory model
              │  Synthadoc (compile) │  ← Document compilation
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   Hermes Layer      │
              │  (Deep research,     │
              │   analysis, curation)│
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   Storage Layer     │
              │                      │
              │  Obsidian Vault      │  ← Human-readable wiki
              │  SQLite (Link)       │  ← FTS search index
              │  OmegaWiki Graph     │  ← Typed knowledge graph
              │  Long-term-memory    │  ← Session/decision store
              └─────────────────────┘
```

## Packages

| Package | Purpose | Inspired By |
|---------|---------|-------------|
| `orchestrator` | Core pipeline: ingest → compile → query → verify → store | Karpathy's LLM Wiki |
| `obsidian-bridge` | Bidirectional sync, semantic cache, concept extraction | Synto |
| `tiered-memory` | Fact → Memory → Wisdom tiered knowledge model | Core-LLM-Wiki |
| `sigma-verifier` | Deterministic contradiction detection | Sigma-Guard |
| `mcp-memory` | MCP server for agent memory queries | Link |

## Directory Structure

```
openclaw-middleware/
├── packages/
│   ├── orchestrator/        # Core orchestrator
│   ├── obsidian-bridge/     # Obsidian sync layer
│   ├── mcp-memory/          # MCP server
│   ├── sigma-verifier/      # Contradiction detection
│   └── tiered-memory/       # Tiered memory model
├── wiki/                    # Compiled wiki
│   ├── index.md             # Content catalog
│   ├── log.md               # Event log
│   ├── concepts/            # Concept pages
│   ├── entities/            # Entity pages
│   └── syntheses/           # Multi-source synthesis
├── memory/                  # Agent memory store
│   ├── recent.md            # Active context
│   ├── archive/             # Aged memories
│   ├── sessions/            # Session artifacts
│   └── decisions/           # Captured decisions
├── claims/                  # Claim provenance
├── graph/                   # Knowledge graph
├── audit/                   # Contradiction proofs
├── config/                  # Schema & configuration
│   ├── AGENTS.md            # Wiki schema
│   └── tier-config.json     # Tier configuration
├── scripts/                 # Management scripts
│   ├── ingest.js            # Source ingestion
│   ├── query.js             # Knowledge search
│   ├── update.js            # Page updates
│   └── lint.js              # Health checks
└── docs/                    # Documentation
```

## Quick Start

### Install Dependencies

```bash
cd openclaw-middleware
pnpm install
```

### Build

```bash
pnpm build
```

### Run MCP Server

```bash
pnpm mcp:server
```

### Ingest a Source

```bash
pnpm wiki:ingest ./path/to/source.md --type article
```

### Query Knowledge

```bash
pnpm wiki:query "What do we know about vector search?" --tiers fact,memory,wisdom
```

### Run Health Check

```bash
pnpm wiki:lint
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSIDIAN_VAULT_PATH` | `/home/duck/Obsidian` | Path to Obsidian vault |
| `WIKI_PATH` | `openclaw-wiki` | Wiki directory in vault |
| `MEMORY_PATH` | `./memory` | Memory store path |
| `GRAPH_PATH` | `./graph` | Knowledge graph path |
| `AUDIT_PATH` | `./audit` | Audit proofs path |

### Tier Configuration

Edit `config/tier-config.json` to customize tiers:

```json
{
  "tiers": {
    "fact": {
      "ttl": 604800000,
      "autoPromote": true
    },
    "memory": {
      "ttl": 2592000000,
      "autoPromote": true
    },
    "wisdom": {
      "ttl": 0,
      "autoPromote": false
    }
  }
}
```

## Integration

### OpenClaw Integration

1. **Cron jobs** → trigger source ingestion
2. **Heartbeat polls** → trigger wiki health checks
3. **User messages** → route through MCP server for memory queries
4. **Heartbeat cron** → run lint pass periodically

### Hermes Integration

1. **MCP query** → retrieve ranked memory chunks with provenance
2. **Tiered memory** → reads from Fact → Memory → Wisdom tiers
3. **Pre-write verification** → Sigma verifier checks for contradictions
4. **Claim store** → Hermes writes research findings as claims with full source tracing

### Obsidian Integration

1. **Bidirectional sync** — your vault IS the wiki
2. **Graph view** — visual orphan detection
3. **Dataview queries** — dynamic tables
4. **Mermaid** — architecture diagrams

## Wiki Schema

All wiki pages use YAML frontmatter + markdown body:

```yaml
---
id: unique-id
type: concept|entity|synthesis|decision|procedure
tags: [tag1, tag2]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - source1
  - source2
provenance:
  originalSource: path/to/source
  extractedAt: YYYY-MM-DD
  chain:
    - step: ingest
      source: path/to/source
---

# Page Title

## Summary
One-line summary.

## Key Points
- Point 1
- Point 2

## Related
- [[related-page]]

## Notes
Additional context.
```

## LLM-Observed Rules

1. **Never delete source files** — always soft-delete in memory tier
2. **Always include provenance** — every claim traces to its source
3. **Run Sigma verifier before writes** — check for contradictions
4. **Update index.md after changes** — keep catalog current
5. **Log all operations** — use log.md for audit trail
6. **Use typed entities** — OmegaWiki-inspired entity types + edges
7. **Maintain tier discipline** — don't promote to Wisdom without curation
8. **Archive old memories** — keep active tiers lean
9. **Sync bidirectionally** — changes in Obsidian should update wiki
10. **Document contradictions** — don't silently merge conflicting facts

## Development

### Add a New Package

```bash
cd packages
mkdir new-package
cd new-package
# Create package.json, tsconfig.json, src/
```

### Run Tests

```bash
pnpm test
```

### Lint

```bash
pnpm lint
```

## Related

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Synto](https://github.com/kytmanov/synto) — Obsidian-native knowledge engine
- [Link](https://github.com/gowtham0992/link) — Local personal memory for LLM agents
- [Sigma-Guard](https://github.com/Jasonleonardvolk/sigma-guard) — Structural verification
- [Core-LLM-Wiki](https://www.npmjs.com/package/@equationalapplications/core-llm-wiki) — Tiered memory model
- [Synthadoc](https://github.com/axoviq-ai/synthadoc) — Knowledge compilation engine
- [OmegaWiki](https://github.com/skyllwt/OmegaWiki) — Research lifecycle wiki
- [LLM-Wiki-Manager](https://github.com/sametbrr/llm-wiki-manager) — Claude Code skill

## License

MIT
