# Contributing to MidMem

Thanks for your interest in contributing! MidMem is an Apache-2.0 licensed
middleware memory layer for LLM agents.

## Ground Rules

- The active codebase is **`packages/core/`**. The other `packages/*` are a
  superseded interim scaffold kept for reference — please don't build on them.
- The core is intentionally **zero-dependency** (Node >= 22.5 built-ins only:
  `node:sqlite`, `crypto`, `fetch`). Please do not add external runtime
  dependencies without discussion first — open an issue to propose it.
- Never commit secrets, credentials, private IP addresses, absolute local
  paths (e.g. home directories), or `state.db` / memory content. Use
  environment variables and the `.gitignore` conventions already in place.

## Prerequisites

- Node.js **>= 22.5** (required for the built-in `node:sqlite`).

## Development Loop

```bash
cd packages/core
node test/smoke.mjs   # end-to-end self-test (offline) -> expect 90/90
npm run verify        # smoke + Brain-style regression bench
```

All changes must keep `npm run verify` green before opening a PR.

## Submitting Changes

1. Fork the repo and create a topic branch from `main`.
2. Make your change with a focused, well-described commit.
3. Ensure `npm run verify` passes in `packages/core`.
4. Open a pull request describing **what** changed and **why**, and note any
   behavior/config changes. Reference related issues.

## Reporting Issues

- **Bugs / features:** open a GitHub Issue with clear reproduction steps.
- **Security vulnerabilities:** do **not** open a public issue — see
  [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
Apache License 2.0, consistent with this project.
