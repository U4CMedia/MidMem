# midmem — trigger-less knowledge routing (design)

**Goal (Don, 2026-06-14):** surface stored knowledge in natural language, frequently, **without
specific triggers** and **without burning context tokens** — ideally via a high-level tagging/linking
tree that simplifies query mechanics.

## The reframe that makes it cheap
Don't make the model *decide* to query. A tool the model calls costs **two model passes** (decide to
call → observe the result) plus **unbounded** result tokens. Instead, make retrieval a **pre-turn
reflex**: a hook runs the query *before* the model's single pass and injects a **token-budgeted**,
**relevance-gated** snippet.
- **Zero extra model passes** (inject, then run once) → no latency tax, no tool-call tokens.
- **Bounded cost**: `query(maxTokens≈600)` caps injected context regardless of store size.
- **Self-gating**: a relevance threshold means low-relevance turns inject ~nothing → near-zero cost.

So "when to query vs not" stops being an LLM decision and becomes a **relevance score**. The system
retrieves cheaply on (nearly) every turn and *surfaces* only what clears the bar. That is how you get
"frequent" for free and "trigger-less" by construction — the user's own sentence is the query
(embedded + searched); no `/wiki`, no keyword list.

## Phase 1 — Proactive budgeted injection (works on today's substrate)
1. Pre-turn hook (OpenClaw `active-memory`-style, currently OFF) embeds the user message (bge-m3,
   already loaded; an embedding call, **not** context tokens) and runs the existing hybrid
   `query(message, maxTokens=600, scopes=[own,shared])`.
2. Gate on the top fused score: below threshold → inject nothing. Above → prepend a compact,
   provenance-tagged block (reuse the `handoff_brief` formatter).
3. Cost = one embedding + an in-process search (no LLM tokens) + ≤600 injected tokens only when
   relevant. Tunables: `maxTokens`, score threshold, max items.

**This alone closes the gap** and is mostly wiring (the retrieval, budget, embeddings, and brief
formatter already exist). Ship it first.

## Phase 2 — The tagging/linking tree (Don's "ultimate goal"): YES, and ~70% of it exists
The substrate is already here:
- **Concept graph** (`nodes`/`edges`) — concepts/entities extracted on every ingest, with relations.
- **Per-entry `concepts`** + a **graph ref-chain boost** already in retrieval.
- **Wikilink projection** — the vault already renders `[[concept]]` pages + an Obsidian graph view.
- **bge-m3 embeddings** + the **lifecycle maintenance pass** (a natural place to build the tree offline).

What's missing, and how to add it:
1. **Concept-node embeddings** — embed each concept (label + a digest of its linked entries). Store
   on the node. Hundreds of nodes, not thousands of entries → a small, fast routing layer.
2. **Hierarchy / branches (the "tree")** — run **graph community detection** (Louvain or
   label-propagation) over the existing edges to cluster concepts into themes = the tree's branches.
   **Zero LLM cost**; recompute in the daily `maintain()` pass. Optionally label each community once
   with the cloud fallback model (rare → cheap) for human-readable branch names.
3. **Route-by-concept retrieval mode** — at query time: embed the turn once → cosine vs **concept
   nodes** (cheap, small set) → matched concepts are the **tags** the message touches → traverse
   edges to sibling/child concepts → fetch only entries tagged in those branches, ranked + budget-
   capped. Hierarchical routing instead of scanning the whole corpus every turn → cheaper *and* more
   precise as the store grows.
4. **Natural language, no triggers** — concepts ARE natural-language labels, so "tell me about X"
   routes to the X concept and its linked branch automatically. The same tree is the human's
   navigable map in Obsidian.

### Why this is cheaper, not just smarter
Matching against a compressed **concept layer** first (route), then fetching within matched branches,
is sublinear vs. re-running full hybrid search over all entries/vectors every turn. The tree is the
index *and* the natural-language interface.

## Honest caveats
- Tree quality rides on concept-extraction quality (local model has offline fallbacks → noisy).
  Mitigate: build/label the taxonomy in the infrequent maintenance pass, LLM-assisted with the cloud
  model where it pays off.
- Thresholds (relevance cutoff, branch fan-out) need tuning — start conservative, use the `feedback`
  loop to learn which surfaced items were helpful (trust already feeds ranking).
- Keep it **fail-soft**: routing miss → fall back to flat hybrid search; never block a turn on recall.

## Build order
1. **Phase 1** proactive budgeted injection + relevance gate (wiring; biggest win per effort).
2. **Phase 2a** concept-node embeddings + community detection in `maintain()` (offline, zero-LLM).
3. **Phase 2b** route-by-concept retrieval mode (fail-soft over flat hybrid).
4. **Phase 2c** optional cloud-labeled branch names + Obsidian tree view polish.
5. Feed `feedback` from "was the proactively-surfaced item used?" to self-tune thresholds.
