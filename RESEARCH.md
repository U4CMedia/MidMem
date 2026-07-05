# RESEARCH — midmem-kb-store

Research and architecture decisions behind **midmem-kb-store**, grounded in published work we
research, develop, architect, and test against. This is a living document; each entry pairs a paper's
finding with the concrete design decision (or safeguard) it drove and how we validate it. Intended to
mature into a publishable record of *why the store is built the way it is*.

## How to add an entry
For each paper, capture: **(1) Paper** (cite + link), **(2) Finding** (the empirical claim that
matters to us), **(3) Decision** (what we changed or chose, and what we deliberately did *not*),
**(4) Validation** (how we test the safeguard holds — prefer deterministic checks + smoke tests).
Keep claims verified against the source, not a model's summary.

> **Operational companion:** [`docs/DEVELOPMENT-GUIDELINES.md`](docs/DEVELOPMENT-GUIDELINES.md) turns
> these findings (DELEGATE-52 grounding, structured-over-fuzzy signals, verify-a-hook-*fires*, call-time
> DB paths, three-tier QA) into the concrete engineering rules that real MidMem integration work
> (OD-CYCLE-004…007) produced. [`docs/STACK-CAPTURE.md`](docs/STACK-CAPTURE.md) records what each agent
> stack actually captures.

---

## 2026-06 — DELEGATE-52: LLMs corrupt documents under delegation
- **Paper:** Laban, Schnabel, Neville (Microsoft Research), *"LLMs Corrupt Your Documents When You
  Delegate"* — DELEGATE-52 benchmark, 19 LLMs × 52 domains. arXiv 2604.15597. (Source ingested in
  midmem; findings verified against it, not a summary.)
- **Findings:** even frontier models corrupt **~25% of content over ~20 delegated interactions**
  (avg ~50% across models); errors are **sparse but severe and compound silently**; **agentic tool
  use does not help (+6% degradation)**; severity rises with **document size, interaction length, and
  distractor context**; short-horizon performance does not predict long-horizon.
- **Decisions (what we built / chose):**
  - **Extraction grounding check** (`src/grounding.mjs`, wired into `ingest`): deterministically
    quarantine extracted concepts/claims whose content-words aren't in the source — *before* they
    persist. Never ask the model to self-verify faithfulness (the paper shows that fails).
  - **Protect `state.db` content, not the projection.** The vault projection is deterministic
    (`project.mjs`, no LLM) and regenerable — it is NOT a corruption surface. The real surfaces are
    *ingest extraction* and *long edit sessions*. (Corrected an earlier mis-analysis that flagged the
    projection.)
  - **Quantitative tier promotion**, never LLM judgment — promotion runs on retrieval/feedback signals.
  - **Bounded, verify-after-write curation** (the `midmem-orchestrator` / `hermes-build-orchestrator`
    loop): cap interactions per unit of work, restrain tools on edits, QA each write against the spec.
  - **Tight, budgeted context** (`handoff_brief`, `proactiveRecall` maxTokens) to limit the
    distractor-context degradation the paper measured.
- **Validation:** `packages/core/test/smoke.mjs` covers grounding (keeps grounded, quarantines
  confabulated, scores) and the ingest grounding report; the `midmem-ingest-review` skill audits
  stored knowledge and cross-checks OpenClaw vs Hermes understanding using deterministic signals.

---

## Backlog — papers to research / architect / test against
- (add candidates here: long-context retrieval fidelity, RAG hallucination measurement, memory
  consolidation / forgetting curves, knowledge-graph grounding, multi-agent memory consistency …)
