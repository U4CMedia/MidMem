# MidMem Skills Library (Claude Code)

Claude Code CLI skills that ship **with** the MidMem middleware, so they travel with the repo and
work wherever it's deployed. They drive MidMem through the same `ocmw` CLI / MCP tools the middleware
exposes — no extra dependencies.

| Skill | Purpose |
|---|---|
| **`midmem-orchestrator`** | Orchestrate knowledge-curation pipelines (bulk ingest, re-ground, dedup, vault verify) with the frontier-plans / Hermes-builds / frontier-QA loop. A MidMem-specialized repurpose of `hermes-build-orchestrator`. |
| **`midmem-ingest-review`** | Ingest LLM Wiki knowledge **and** review/audit its quality + the two stacks' understanding — cross-checks OpenClaw vs Hermes scope to catch confabulation, drift, contradictions, scope leakage, and divergent assumptions. The QA gate for `midmem-orchestrator`. |

They compose: `midmem-orchestrator` drives bulk curation, `midmem-ingest-review` is its per-card QA
gate. Both follow the DELEGATE-52 posture — judge quality by **deterministic signals** (grounding
scores, contradiction checks, cross-stack agreement), never by asking a model "is this faithful?"

## Install (make discoverable to Claude Code)
Claude Code discovers skills in `~/.claude/skills/`. Symlink the library skills in (keeps the
canonical files here in the repo):
```bash
for s in midmem-orchestrator midmem-ingest-review; do
  ln -sfn "$(pwd)/skills/$s" "$HOME/.claude/skills/$s"
done
```
On the OpenDuck machine this is already done. Re-run after a fresh checkout of the middleware repo.

## Related (not in this library)
- `midmem-ops` — an **OpenClaw** skill (lives in `~/.openclaw/workspace/skills/`) for OpenClaw to
  operate the store directly. See the repo README's *Skills — which one to use per integration*.
- `hermes-build-orchestrator` — the general Claude Code build-orchestration skill these repurpose.
