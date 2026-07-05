# Wiki Schema (AGENTS.md)

> Configuration for the OpenClaw + Hermes middleware wiki
> This file defines the schema for wiki pages and the knowledge structure

## Structure

### Directories

- `wiki/` — Compiled knowledge base (Karpathy's layer 2)
  - `index.md` — Content-oriented catalog (auto-generated)
  - `log.md` — Chronological event log (Karpathy's layer 3)
  - `concepts/` — Concept pages
  - `entities/` — Entity pages (people, orgs, tools)
  - `syntheses/` — Multi-source synthesis pages
- `memory/` — Agent memory store
  - `recent.md` — Active context
  - `archive/` — Aged memories
  - `sessions/` — Session artifacts
  - `decisions/` — Captured decisions
- `claims/` — Claim provenance (Synthadoc-style)
- `graph/` — Typed knowledge graph
- `audit/` — Contradiction proofs

### Page Format

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
One-line summary of the page content.

## Key Points
- Point 1
- Point 2
- Point 3

## Related
- [[related-page]]
- [[another-page]]

## Notes
Additional notes, context, or analysis.
```

### Tier Configuration

The tiered memory model uses three tiers:

1. **Fact** — Raw, unprocessed knowledge from sources
   - TTL: 7 days
   - Auto-promote: Yes
   - Sync to Obsidian: Yes

2. **Memory** — Synthesized knowledge with context
   - TTL: 30 days
   - Auto-promote: Yes
   - Sync to Obsidian: Yes

3. **Wisdom** — Curated, verified knowledge
   - TTL: No expiry
   - Auto-promote: No (manual curation)
   - Sync to Obsidian: Yes

### Integration Points

#### OpenClaw → Middleware
- Cron jobs → trigger source ingestion
- Heartbeat polls → trigger wiki health checks
- User messages → route through MCP server for memory queries
- Heartbeat cron → run lint pass periodically

#### Hermes → Middleware
- MCP query → retrieve ranked memory chunks with provenance
- Tiered memory → reads from Fact → Memory → Wisdom tiers
- Pre-write verification → Sigma verifier checks for contradictions
- Claim store → Hermes writes research findings as claims with full source tracing

#### Obsidian Vault (Human Interface)
- Bidirectional sync — your vault IS the wiki
- Graph view — visual orphan detection
- Dataview queries — dynamic tables
- Mermaid — architecture diagrams

### LLM-Observed Rules

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
