---
name: midmem-record
description: >-
  Record a change/decision/lesson durably into MidMem the RIGHT way — a distilled lesson into the
  wisdom tier, a clean commit, and (optionally) a changelog entry. Use after any capability/config
  change or when asked to "record this", "log it", "remember this lesson", "checkpoint". Encodes the
  harness-guaranteed recording pattern and avoids the escaping/formatting slips that happen by hand.
  The portable, Claude-Code-only sibling of an operator's host recording skill.
---

# MidMem Record — durable lessons + commit, done right

The point: durable knowledge must land in `state.db`, not just the chat transcript, so it survives
context compaction and is recallable by **every** agent on the shared store.

## Steps
1. **Lesson → midmem (the load-bearing step).** Store each lesson atomically:
   `midmem remember "<the lesson, one sentence>" --tier wisdom --curated --scope shared`
   - ⚠️ **Escaping gotcha:** the text must not contain backticks, `$(...)`, or unescaped `<> |` — the
     shell runs them as substitution and mangles/blanks the entry. Plain prose, no backticks; replace
     code refs with words ("call query with a token budget", not the backticked form). One per lesson.
2. **Changelog (if your project keeps one).** Add under today's dated `## YYYY-MM-DD` section (newest
   at top), grouped: **Added · Changed · Fixed · Reverted · Removed · Failed Attempts · Lessons**
   (omit empty groups). Be specific with values/paths ("rrfK 60→45", not "tuned retrieval").
   - ⚠️ **One dated section per day, one of each group per day** — append to today's existing groups;
     don't create a second `## <date>` or a second `### Lessons`. `grep -nE '^## |^### ' CHANGELOG.md`
     should show no duplicate date/group headers for one day.
3. **Vault projection.** `midmem project` refreshes the LLM Wiki (or let lifecycle maintenance
   auto-project); only force if you need it visible immediately. **Never hand-edit the projection** —
   it is regenerated from `state.db`.
4. **Commit.** Stage the changed files (+ changelog if touched). End the message with the active
   model's `Co-Authored-By:` line. Verify the staged diff carries **no secrets** — `state.db`,
   `*.pem`, `.env`, and service-account JSON should be gitignored; check before committing.

## Harness-guaranteed recording (the reliable pattern)
Instruction-following alone loses records — a session ends, the lesson evaporates. Make it
deterministic: wire a Claude Code **`Stop` hook** (via `.claude/settings.json`) that **blocks a turn
from ending while a recordable change is unrecorded**, clearing when `midmem remember` / `midmem
ingest` runs. A companion `PostToolUse` hook flags the session "dirty" when a mutating command runs.
This turns "please remember to record" into a gate the session cannot skip. Make it **fail open** on
error and **yield after a few blocks** so it never wedges a session. (This is the model behind an
operator's host `record` skill; this repo copy keeps the portable pattern without the host-specific
changelog/vault plumbing.)

## Don't
- Don't `midmem ingest` a live, churning changelog — one lossy summary per edit supersede-thrashes the
  store. Lessons go via `remember`; ingest only **frozen** archives, once.
- Don't ingest from outside an allowed source root (`MIDMEM_SOURCE_ROOTS`) — governance rejects it.
  Copy the doc under an allowed root first.
- Don't commit secrets — verify the staged diff every time.
