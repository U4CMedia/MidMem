# `packages/core` — the midmem-kb-store engine

The runnable foundation: a single SQLite source-of-truth (`state.db`), hybrid retrieval, tiered
memory with a self-driving lifecycle, a typed graph, claims/provenance, fail-closed governance, an
Obsidian projection, and a DELEGATE-52 extraction-grounding check — exposed over MCP, a CLI, and a
programmatic API. Node ESM, **zero external deps** (Node ≥ 22.5 built-ins).

## Layout
- `src/` — the modules. Key ones: `orchestrator.mjs` (the coordinator/API), `db.mjs` (`state.db`),
  `retrieval.mjs` (FTS5 ⊕ trigram ⊕ vector / RRF), `memory.mjs` (tiers + lifecycle),
  `grounding.mjs` (DELEGATE-52 safeguard), `governance.mjs` (fail-closed), `project.mjs`
  (deterministic vault projection), `config.mjs` (env: `MIDMEM_*`, legacy `OCMW_*` fallback).
- `bin/` — `cli.mjs` (the `midmem` CLI) and `mcp-server.mjs` (stdio MCP server, the agent contract).
- `test/smoke.mjs` — offline, dependency-free end-to-end self-test.

## Run
```bash
node test/smoke.mjs                 # end-to-end self-test (offline) — expect all pass
node bin/cli.mjs brief              # or: midmem brief   (via ~/.local/bin/midmem)
```

## Env (prefix `MIDMEM_`, legacy `OCMW_` still read as a fallback)
`MIDMEM_DB_PATH`, `OBSIDIAN_VAULT_PATH`, `WIKI_PATH`, `MIDMEM_LLM_ENDPOINT`, `MIDMEM_EMBED_MODEL`,
`MIDMEM_AGENT_SCOPE`, `MIDMEM_VECTOR_BACKEND`, `MIDMEM_GROUNDING_MIN_OVERLAP`, `MIDMEM_PROACTIVE_RECALL`…
(see `src/config.mjs`).

← Back to the [main README](../../README.md) · [Skills library](../../skills/README.md) ·
[RESEARCH](../../RESEARCH.md)
