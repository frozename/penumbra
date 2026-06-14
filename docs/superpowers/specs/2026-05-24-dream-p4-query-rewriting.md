---
title: Dream P4 query rewriting — separating value from cost
date: 2026-05-24
status: draft
---

## Problem

`packages/daemon/src/dreaming/cycle.ts:512-513` sends the raw t2 memory title verbatim to
`sanitizeTitleForQuery`, which only trims and length-caps. Project-internal strings reach Firecrawl
with a 0-result guarantee. Examples from production:

- "Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id" — internal identifiers
- "Test-driven development workflow for engine registry" — internal terminology
- "Split behavior change" — too vague

All returned 0 results and were cached as negative sentinels. The cost-control is solid; the value
is zero.

### Root cause

`sanitizeTitleForQuery` (`packages/daemon/src/dreaming/query-sanitize.ts`) only does: trim, length
cap (<=200 chars), reject URLs and control chars. No semantic transformation.

## Goals

1. Generate web-shaped queries from project-internal t2 titles.
2. Drop queries that cannot be rewritten rather than sending them as no-ops.
3. Insert rewriting BEFORE `sanitizeTitleForQuery` call (`cycle.ts:513`).
4. Do not regress cost-leak guarantees — negative cache, P4 backoff, Firecrawl adapter unchanged.

## Non-goals

- Rewriting research results (snippets / extracts).
- Replacing Firecrawl.
- Cross-project query sharing.

## Solution

**Phase 1 — Heuristic gate**: `isWebSearchable(title: string): boolean` rejects titles matching:

- Conventional commit prefix (feat|fix|chore|docs|test|refactor|style|perf|ci|build|revert)
- Contains project-internal terms: handoff, handoff_id, dispatch_land, worktree, t2, t1, t0,
  cycle_id, dream_action, penumbra, rollup_id, lane_id, maestro, agentchat
- camelCase identifier >= 8 chars with mid-capitals
- snake_case.dot.path pattern (2+ separators)
- Content word count < 4 or > 12
- URL prefix

Rejected titles skip the P4 action queue entirely. Logged at info:
`{ event: "dream_p4_query_rejected_unsearchable", memory_id, title }`.

**Phase 2 — LLM rewriter (optional)**: `QueryRewriterAgent` injected via
`DreamCycleDeps.queryRewriter` (optional field). Receives title, returns `{query}` or
`{skip, reason}`. Schema-guarded (zod). Falls back to Phase 1 heuristic on model error.

## Affected files

- New: `packages/daemon/src/dreaming/is-web-searchable.ts`
- New: `packages/daemon/src/dreaming/query-rewriter.ts` (Phase 2)
- Edit: `packages/daemon/src/dreaming/cycle.ts` line ~512 (P4 loop)
- New: `packages/daemon/test/dreaming/query-rewriting.test.ts`
