---
title: Dream P4 query rewriting — phased TDD plan
date: 2026-05-24
spec: docs/superpowers/specs/2026-05-24-dream-p4-query-rewriting.md
status: completed
completed: 2026-05-24
superseded_by: docs/superpowers/plans/2026-05-24-dream-query-rewriter-llm.md
---

> **Status: completed 2026-05-24.**
>
> - **Phase 1** (heuristic `isWebSearchable` gate) shipped in `1b950690`
>   — `feat(daemon-dreaming): P4 query gate — drop unsearchable t2 titles before minting`.
> - **Phase 2** (LLM rewriter) was scoped out of this plan and executed via
>   `docs/superpowers/plans/2026-05-24-dream-query-rewriter-llm.md` (Candidate B).
>   That plan shipped phases 0-4 (`8cdb9b79`, `1ce76ba9`, `4619fc3a`, `5fcac028`,
>   `abb07ef3`, `00f4fbe7`, `b55aec6c`) with adversarial fixes in `c9529e42`,
>   a benchmark harness (`2ed318c9`, `62fc8d8a`), and llamactl proxy routing
>   (`1bd9c075`, `b5fd7ffb`).
> - **Phase 3** (embedding-space concept extraction) remains deferred per the
>   original gate (trigger only if quality < 70% for ≥ 2 consecutive samples).

## Context

`cycle.ts:512-513` sends the raw t2 memory title verbatim to `sanitizeTitleForQuery`, which only
trims and length-caps. Project-internal strings (commit messages, internal identifiers, jargon)
reach Firecrawl with a 0-result guarantee. The cost-control is solid; the value is zero.

**Constraint**: existing negative-sentinel cache, P4 backoff, Firecrawl adapter stay untouched.
This is purely additive.

---

## Phase 1 — Heuristic isWebSearchable gate

### 1.1 Failing tests first

**New file**: `packages/daemon/test/dreaming/query-rewriting.test.ts`

Write unit tests for `isWebSearchable()` that must fail before any implementation exists.

REJECT cases:
- `"feat(daemon): fix dispatch_land resolve"` → false (conventional commit)
- `"Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id"` → false (internal terms)
- `"Split behavior change"` → false (< 4 content words)
- `"Refactoring"` → false (1 word)
- `"t2 memory promotion flow in penumbra"` → false (internal terms: t2, penumbra)
- `"Resolve worktree path from handoff_id context"` → false (internal: handoff_id, worktree)
- `"https://github.com/foo/bar"` → false (URL)
- 13-word title → false (> 12 content words)

ACCEPT cases:
- `"TypeScript async generator patterns for streaming APIs"` → true
- `"SQLite FTS5 tokenizer configuration options"` → true
- `"Bun runtime module resolution with native addons"` → true
- `"LLM evaluation approaches for code generation tasks"` → true

Also add integration test in `packages/daemon/test/dreaming/cycle.test.ts` after line 735:
```
it("P4 skips research_query seeding when t2 title fails isWebSearchable gate", ...)
```
Seeds a memory with title `"feat(daemon): fix handoff_id resolver"`, runs cycle, expects
zero `research_query` dream_actions.
Run to confirm all fail:
```
bun test packages/daemon/test/dreaming/query-rewriting.test.ts
```

### 1.2 Implementation

**New file**: `packages/daemon/src/dreaming/is-web-searchable.ts`

Export `isWebSearchable(title: string): boolean`. Rules (in order):
1. Reject if matches URL_RE (`/^https?:\/\//i`)
2. Reject if matches CONVENTIONAL_COMMIT_RE (`/^(feat|fix|chore|docs|test|refactor|style|perf|ci|build|revert)(\([^)]*\))?:/i`)
3. Reject if title.toLowerCase() contains any INTERNAL_TERMS token:
   `handoff, handoff_id, dispatch_land, worktree, t2, t1, t0, cycle_id, dream_action, penumbra,
   rollup_id, lane_id, maestro, agentchat, negkey, p4queuemax, pressureguard, briefsynthesizer`
4. Reject if any token matches camelCase >=8 chars with mid-capital (hasCamelIdentifier)
5. Reject if matches SNAKE_DOT_RE (`/\b\w+[._]\w+[._]\w+\b/`)
6. Reject if content word count (after removing stop words) < 4
7. Reject if content word count > 12
8. Return true

**Edit `packages/daemon/src/dreaming/cycle.ts`**:

At line 42 (existing import block): add `import { isWebSearchable } from "./is-web-searchable.ts";`

At line 512 (P4 loop start), insert gate before `const query = sanitizeTitleForQuery(memory.title)`:
```
if (!isWebSearchable(memory.title)) {
  logger.info({ event: "dream_p4_query_rejected_unsearchable", memory_id: memory.memory_id, title: memory.title });
  continue;
}
```

No schema changes. No daemon restart required.

### 1.3 Verify

```
bun test packages/daemon/test/dreaming/query-rewriting.test.ts   # all pass
bun test packages/daemon/test/dreaming/cycle.test.ts             # full P4 suite green
bun test packages/daemon/                                         # full suite green
```

Post-deploy: scan daemon logs for `dream_p4_query_rejected_unsearchable`. Review 10 rejected and
10 accepted titles from real corpus to tune INTERNAL_TERMS if false-reject rate is high.
The existing URL-filter test at `cycle.test.ts:723` must still pass.

---

## Phase 2 — LLM query rewriter

**Prerequisite**: Phase 1 landed. Log data shows >= 50% of corpus titles rejected by heuristic
gate AND accepted-title quality is insufficient.

### 2.1 Failing tests first

Append to `packages/daemon/test/dreaming/query-rewriting.test.ts`:

Import `rewriteQueryForSearch` and `QueryRewriterAgent` from `../../src/dreaming/query-rewriter.ts`.

Tests (all fail until implementation exists):
- Mock agent returns `{query: "SQLite WAL mode write concurrency"}` → kind: "rewritten"
- Mock agent returns `{skip: true, reason: "internal only"}` → kind: "skip"
- Mock agent returns `{invalid_key: true}` (schema error) + searchable title → kind: "rewritten" (fallback)
- Mock agent returns `{invalid_key: true}` (schema error) + unsearchable title → kind: "skip" (fallback)
- Mock agent throws → kind: "rewritten" when title is searchable, "skip" when not

### 2.2 Implementation

**New file**: `packages/daemon/src/dreaming/query-rewriter.ts`

Export:
- `interface QueryRewriterAgent { ask(payload: {title: string; body_excerpt?: string}): Promise<unknown> }`
- `type RewriteResult = { kind: "rewritten"; query: string } | { kind: "skip"; reason: string }`
- `async function rewriteQueryForSearch(title: string, agent: QueryRewriterAgent): Promise<RewriteResult>`

Implementation: try `agent.ask({title})`, parse with zod schema
`z.union([z.object({query: z.string().min(4).max(200)}), z.object({skip: z.literal(true), reason: z.string()})])`.
On success: return `{kind: "rewritten", query}` or `{kind: "skip", reason}`.
On schema failure or throw: call `fallback(title)` which calls `isWebSearchable(title)` — return
`{kind: "rewritten", query: title}` if searchable, `{kind: "skip", reason: "fallback_heuristic_rejected"}` if not.

**Edit `packages/daemon/src/dreaming/cycle.ts`**:

Add to `DreamCycleDeps` interface (line ~47): `queryRewriter?: QueryRewriterAgent;`

Add imports: `rewriteQueryForSearch` and `QueryRewriterAgent` from `./query-rewriter.ts`

Replace Phase 1 gate in P4 loop with:
```
let queryText: string;
if (deps.queryRewriter) {
  const rewrite = await rewriteQueryForSearch(memory.title, deps.queryRewriter);
  if (rewrite.kind === "skip") {
    logger.info({ event: "dream_p4_query_skipped_by_rewriter", memory_id: memory.memory_id });
    continue;
  }
  queryText = rewrite.query;
} else {
  if (!isWebSearchable(memory.title)) {
    logger.info({ event: "dream_p4_query_rejected_unsearchable", memory_id: memory.memory_id });
    continue;
  }
  queryText = memory.title;
}
const query = sanitizeTitleForQuery(queryText);
```

`queryRewriter` is optional — all existing callers stay compatible. No schema migration. No restart.

### 2.3 Verify

```
bun test packages/daemon/test/dreaming/query-rewriting.test.ts   # all pass
bun test packages/daemon/test/dreaming/cycle.test.ts             # all P4 tests green
bun test packages/daemon/                                         # full suite green
```

Quality check after 1 week: pull 20 dream_actions where action_type='research_query' and
status='approved', read payload_json.query, score "would a developer type this?" (binary).
Target >= 80% yes.

---

## Phase 3 — Embedding-space concept extraction (deferred)

Skip unless Phase 2 quality score is below 70% for >= 2 consecutive weekly samples.

---

## Open questions

1. Internal-term seed list: start hard-coded. Add ~/.penumbra/<project>/dream-query-terms.yaml
   override hook in a follow-up if false-reject rate proves high.
2. End-to-end value telemetry: file a separate task for dream_research_finding_used_in_brief t0
event to enable measurable quality evaluation beyond manual spot-checks.
3. p4QueueMax: queue underfill with gate active is fine. Revisit only if non-t2-title sources added.
