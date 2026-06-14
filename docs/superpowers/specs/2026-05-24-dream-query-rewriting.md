---
title: Dream research query rewriting — separating value from cost
date: 2026-05-24
status: draft (not yet planned or dispatched)
related:
  - docs/superpowers/specs/2026-05-23-dream-p4-p5-firecrawl-cost-leak.md (shipped)
  - memory [[project-dream-p5-research-cache-key-mismatch-2026-05-23]]
---

## Problem

The cost-leak fix shipped on 2026-05-23 (commits `936fb59b` through `b9c066c3`) successfully prevents redundant Firecrawl billing — the negative-result cache catches empty results and the P4 backoff skips queries with fresh sentinels. Real-world steady-state is ≈4 bills across ~14 hours, well under the ≤4/h worst-case forecast.

But the Firecrawl Activity Logs for 2026-05-24 reveal a more important issue: **the queries themselves are unfit for web search**. Examples from production:

| Query (sent to Firecrawl)                                               | Source shape         | Why it's useless                                                                                   |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id` | commit message       | "dispatch_land" / "handoff.project_id" are penumbra-internal identifiers; no public page uses them |
| `Test-driven development workflow for engine registry`                  | architectural note   | "engine registry" is project-internal terminology                                                  |
| `Split behavior change`                                                 | terse rollup excerpt | too vague to match anything specific; would match millions of unrelated pages                      |

All three returned **0 results** and were then cached as negative sentinels. The cost-control story is solid, but the **value story is zero**: the system is correctly avoiding billing on queries that were never going to find anything useful in the first place.

### Root cause (located in code)

`packages/daemon/src/dreaming/cycle.ts:512-513`:

```ts
for (const memory of memories) {
  const query = sanitizeTitleForQuery(memory.title);
```

The query string sent to Firecrawl is **the t2 memory title, verbatim**, passed through `sanitizeTitleForQuery` (`packages/daemon/src/dreaming/query-sanitize.ts`) which only does:

- trim
- length cap (≤ 200 chars)
- reject URLs and control characters

No semantic transformation. No concept extraction. No rewriting. The pipeline assumes "t2 title = good search query" — which is wrong for the project-internal titles that dominate the t2 corpus (commit-message titles, file-path-derived titles, internal jargon).

### Why this matters beyond zero-bill noise

1. **The dreaming pipeline's purpose is to surface external knowledge relevant to project work.** If queries never hit relevant pages, the pipeline ships no value — only consumes capacity.
2. **Negative sentinels mask the failure.** With the cost-leak fix in place, the system silently "works" — no bills, no errors, no logs except `[dream-p4] skipping query due to negative-cache hit`. There is no signal that the queries are bad; only that they're cheap.
3. **t2 titles will continue to be project-internal.** As the memory store grows, the proportion of project-internal-title queries goes up, not down. Manual maintenance of "good queries" doesn't scale.

## Goals

1. **Generate web-shaped queries** from project-internal t2 memory titles — queries that have a plausible chance of matching public technical content.
2. **Drop queries that can't be rewritten** rather than ship them to Firecrawl as no-ops. Failing fast at mint time is cheaper than a negative-sentinel round-trip.
3. **Preserve the existing P4 → P5 contract** (`dream_actions.payload_json.query` is the string sent to the adapter). Insert rewriting BEFORE the action is minted, not after.
4. **Don't regress the cost-leak guarantees.** The cost-control architecture (negative cache, backoff, server-side domain filter) stays in place. Rewriting is additive.

## Non-goals

- Rewriting **research results** (snippets / extracts). Out of scope; this spec is only about input queries.
- Replacing Firecrawl. The provider stays.
- Auto-generating queries from sources OTHER than t2 memory titles. Future scope (e.g. from t1 rollups, dispatch failures, etc.) is a separate spec.
- Cross-project query sharing. Per-project scope stays.

## Solution candidates

Three approaches, ranked by implementation cost (lowest first). They are **not mutually exclusive** — a hybrid is reasonable.

### Candidate A — Heuristic "drop too vague / too specific" gate

Cheapest. Before `sanitizeTitleForQuery`, add a `isWebSearchable(title)` check that rejects titles matching any of:

- Contains code-shaped identifiers (camelCase ≥ 8 chars with internal capitals, `snake_case_with_dots.like_this`, `module.function.path`).
- Contains commit-message shapes (starts with `feat(...)`, `fix(...)`, etc., or contains `—` followed by file path).
- Too short to disambiguate (< 4 words after stop-word removal).
- Too long to be a search query (> 12 words). Firecrawl is full-text, not natural-language QA.
- Contains penumbra-internal terms from an allowlist of project nouns (`handoff`, `dispatch_land`, `t2`, `cycle_id`, etc. — derived from the project corpus).

Rejected titles never become dream_actions, so no Firecrawl bill and no negative sentinel. Logged at info: `{ event: 'dream_p4_query_rejected_unsearchable', title, reason }`.

**Pros:** Pure local logic. No model call. Cheap. Failure mode: false rejection (a marginal title that COULD have produced a useful query). Recoverable: the memory stays minted; only research is skipped.

**Cons:** Doesn't actually generate good queries — just stops sending bad ones. Reduces noise but doesn't add value.

### Candidate B — Local LLM query rewriter (small model)

A `local-qwen3-coder` or `gemini-flash` agent receives `{title, project_id, body_excerpt}` and returns either:

- `{ query: "<rewritten search query>" }`
- `{ skip: true, reason: "<one line>" }`

Inserted between memory fetch and the existing `sanitizeTitleForQuery` call. Schema-guard the response (zod). On model failure or schema error, fall back to the heuristic gate (Candidate A) — never crash the dreaming cron.

**Pros:** Can actually generate value. Cheap (small model, short prompt). Generalizes well to titles the heuristic gate would falsely reject.

**Cons:** Adds a dependency on agent availability. Latency per query (~1-3s). Needs a system prompt + few-shot examples that survive prompt drift.

### Candidate C — Concept extraction via embedding-space search of public technical glossaries

For each memory, embed the body + title, find nearest neighbors in a pre-indexed glossary of (CS / TypeScript / Bun / SQLite / etc.) terms. The top-N glossary terms become the search query.

**Pros:** Deterministic, low-cost at query time (one embedding + one ANN query).

**Cons:** Requires building + maintaining the glossary index. Large upfront effort. Likely worse output quality than B.

## Recommendation

**Phase 1: Ship Candidate A standalone.** Adds value immediately (stops bad bills, surfaces signal that the corpus has many unsearchable titles), doesn't require model dependencies, easy to test.

**Phase 2: Layer Candidate B on top.** Use the heuristic gate as a fallback when the rewriter says skip or fails to respond. Run for 1-2 weeks, measure quality (samples of rewritten queries vs. their Firecrawl results).

**Phase 3 (maybe):** Candidate C if the rewriter quality plateaus.

## Open questions

1. **What's "good" to validate against?** With no public-search ground truth, A/B is hard. Proposal: human spot-check 20 rewrites per week for the first month; track "would a developer search for this?" as a binary signal.
2. **What about t2 bodies, not just titles?** The body has more context. Worth including in the rewriter prompt (Candidate B). Candidate A might also peek at body length and reject titles whose body is also too short / penumbra-internal.
3. **How does this interact with the existing P4 batch size cap?** `p4QueueMax` (in dreaming config) limits queued queries. If the rewriter rejects many, the cap is harder to hit — adjust? Probably fine to leave as-is; underflow is a non-issue.
4. **Allow-list seeding for Candidate A.** The list of penumbra-internal terms needs to come from somewhere. Options: derive from t2 corpus (top-N frequent project-only tokens), hand-curate, or both. Hand-curate seed + auto-extend.
5. **Telemetry.** Today there's no signal of "research found anything useful vs. found-but-irrelevant". Worth adding a t0 event for `dream_research_finding_used_in_brief` so we can measure end-to-end value, not just bill count.

## Affected files (Candidate A scope, indicative)

- `packages/daemon/src/dreaming/query-sanitize.ts` — extend or add a sibling `is-web-searchable.ts`.
- `packages/daemon/src/dreaming/cycle.ts:513` — call the new gate before the existing sanitize.
- New: `packages/daemon/test/dreaming/query-rewriting.test.ts` — heuristic test cases pinned against real example titles from production.
- Optional: a `~/.penumbra/dream-query-internal-terms.yaml` config file for the project-internal term allowlist (per-project override of the seed list).

## What's NOT changing

The cost-leak architecture stays untouched:

- Negative-result cache (`dream_research_cache.is_negative`) keeps catching empty results.
- P4 backoff still skips queries with fresh negative sentinels.
- Firecrawl /v2 `includeDomains` still scopes to allowed domains.

This spec is purely additive: rewrite (or drop) the query BEFORE it enters the action queue, so the cost-control stays unstressed and the queries that do reach Firecrawl have a real chance of returning value.
