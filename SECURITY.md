# Security Policy

## Supported Versions

MidMem is pre-1.0 and under active development. Security fixes are applied
to the `main` branch (the active `packages/core` foundation). The legacy
interim scaffold under `packages/{orchestrator,tiered-memory,obsidian-bridge,
sigma-verifier,mcp-memory}` is reference-only and not supported.

| Version | Supported |
| ------- | --------- |
| main (packages/core) | :white_check_mark: |
| legacy scaffold      | :x:                |

## Reporting a Vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately using GitHub's **Private vulnerability reporting**:
open the **Security** tab of this repository and click
**"Report a vulnerability"**. This creates a private advisory visible only
to the maintainers.

When reporting, please include:

- A description of the issue and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected file(s), component, or configuration
- Any suggested remediation

## Response Expectations

This is a small, volunteer-maintained open-source project. We aim to
acknowledge reports within a reasonable time and will coordinate a fix and
disclosure timeline with you. Please allow a reasonable period for a fix
before any public disclosure.

## Scope & Notes

- MidMem's active core has **zero external runtime dependencies** (Node >= 22.5
  built-ins only), which keeps the dependency attack surface minimal.
- The knowledge store (`state.db`) and any memory content are intended to
  stay local; they are git-ignored and must never be committed to a remote.
- Configuration values such as LLM endpoints should be supplied via
  environment variables, not committed to the repository.
