# Dream Research Query Rewriting Implementation Plan

> **Status: superseded 2026-05-24.** The minimal heuristic-gate variant proposed
> here was folded into the broader phased plan at
> [`2026-05-24-dream-p4-query-rewriting-plan.md`](2026-05-24-dream-p4-query-rewriting-plan.md)
> and replaced by the LLM rewriter at
> [`2026-05-24-dream-query-rewriter-llm.md`](2026-05-24-dream-query-rewriter-llm.md).
>
> What landed instead of executing this checklist:
> - The heuristic gate (Tasks 1-3 here) shipped in `1b950690`
>   — `feat(daemon-dreaming): P4 query gate — drop unsearchable t2 titles before minting`
>   — under the module name `is-web-searchable.ts` rather than `query-searchability.ts`.
> - The LLM rewriter that this plan deliberately deferred has now also shipped
>   (commits `8cdb9b79` → `b5fd7ffb`), so the "Out of scope" section here is
>   no longer accurate as a future-direction note.
>
> Per-task checkboxes below are left unticked as plan archaeology.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop minting Firecrawl research queries from t2 titles that are clearly unsearchable, so the dreaming pipeline spends less on dead queries and only ships web-shaped queries that have a real chance of returning value.

**Architecture:** Keep the existing P4/P5 contract intact: `dream_actions.payload_json.query` remains the string sent to research. Add a small local gate before minting the action, using pure string heuristics only. The gate should reject obvious project-internal or code-shaped titles, and it should do so before query sanitization and before negative-cache lookup so no action is minted for hopeless inputs.

**Tech Stack:** Bun + TypeScript, `bun:test`, existing daemon dreaming modules, existing SQLite-backed dream schema.

---

### Task 1: Add a focused searchability gate test suite

**Files:**
- Create: `packages/daemon/test/dreaming/query-searchability.test.ts`
- Create: `packages/daemon/src/dreaming/query-searchability.ts`

- [ ] **Step 1: Write the failing test**

Add a dedicated unit test file for the new gate. Keep it isolated from the sanitizer tests so the responsibilities stay separate:

```ts
import { expect, it, describe } from 'bun:test';
import { isWebSearchableTitle } from '../../src/dreaming/query-searchability.js';

describe('dreaming/query-searchability', () => {
  it('rejects internal or code-shaped titles', () => {
    expect(isWebSearchableTitle('Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id')).toBe(false);
    expect(isWebSearchableTitle('Test-driven development workflow for engine registry')).toBe(false);
    expect(isWebSearchableTitle('Split behavior change')).toBe(false);
  });

  it('allows titles that are already web-shaped', () => {
    expect(isWebSearchableTitle('SQLite negative cache design')).toBe(true);
    expect(isWebSearchableTitle('Bun sqlite transaction rollback semantics')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/query-searchability.test.ts`

Expected: FAIL with `Cannot find module '../../src/dreaming/query-searchability.js'` or equivalent missing-export error.

- [ ] **Step 3: Write the minimal implementation**

Create a small sibling module that only answers whether a title should be considered web-searchable:

```ts
const INTERNAL_TOKENS = [
  'dispatch_land',
  'handoff',
  't2',
  'cycle_id',
  'dream_actions',
  'dream_cycles',
];

export function isWebSearchableTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.split(/\s+/).length < 4) return false;
  if (trimmed.split(/\s+/).length > 12) return false;
  if (/^[a-z]+\(.*\)/i.test(trimmed)) return false;
  if (/[A-Za-z]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z0-9_.]+/.test(trimmed)) return false;
  if (INTERNAL_TOKENS.some((token) => trimmed.toLowerCase().includes(token.toLowerCase()))) return false;
  return true;
}
```

Keep it conservative. The point of the first pass is to stop the obvious junk, not to invent a perfect classifier.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/daemon/test/dreaming/query-searchability.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/test/dreaming/query-searchability.test.ts packages/daemon/src/dreaming/query-searchability.ts
git commit -m "feat(dreaming): gate unsearchable research titles"
```

### Task 2: Wire the gate into P4 query minting

**Files:**
- Modify: `packages/daemon/src/dreaming/cycle.ts:42,513-531`
- Create: `packages/daemon/src/dreaming/query-searchability.ts`
- Modify: `packages/daemon/test/dreaming/cycle.test.ts`
- Modify: `packages/daemon/test/dreaming/query-searchability.test.ts`

- [ ] **Step 1: Write the failing test**

Add a cycle-level regression that seeds a project with an obviously internal title and verifies that no `research_query` action is queued:

```ts
it('P4 skips unsearchable titles before minting research_query actions', async () => {
  const db = openTestDb();
  const projectId = 'proj-dream';
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: 'Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id',
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);

  await runDreamCycle(db, testConfig(), { projectRegistry });

  const queued = db.prepare(
    `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status='queued'`,
  ).get() as { n: number };
  expect(queued.n).toBe(0);
});
```

If the current test harness uses a different project registry fixture, adapt the seed to the existing helper instead of adding a second registry abstraction.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/daemon/test/dreaming/cycle.test.ts -t "P4 skips unsearchable titles before minting research_query actions"`

Expected: FAIL because the cycle still queues a `research_query` action from the internal title.

- [ ] **Step 3: Write the minimal implementation**

Change the cycle so it calls the new gate before `sanitizeTitleForQuery`, and drop the memory entirely if the gate rejects the title:

```ts
import { isWebSearchableTitle } from './query-searchability.js';
import { sanitizeTitleForQuery } from './query-sanitize.js';

for (const memory of memories) {
  if (!isWebSearchableTitle(memory.title)) {
    console.log('[dream-p4] skipping unsearchable query title', {
      project_id: project.project_id,
      memory_id: memory.memory_id,
      title: memory.title,
    });
    continue;
  }

  const query = sanitizeTitleForQuery(memory.title);
  if (!query) continue;
  // existing negative-cache lookup and queue insertion stay unchanged
}
```

Keep `sanitizeTitleForQuery` unchanged except for any import cleanup. The searchability gate is the only new behavior.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test packages/daemon/test/dreaming/query-searchability.test.ts
bun test packages/daemon/test/dreaming/cycle.test.ts -t "P4 skips unsearchable titles before minting research_query actions"
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/dreaming/cycle.ts packages/daemon/src/dreaming/query-searchability.ts packages/daemon/test/dreaming/cycle.test.ts packages/daemon/test/dreaming/query-searchability.test.ts
git commit -m "feat(dreaming): skip unsearchable research queries"
```

### Task 3: Verify the change against the dreaming test slice

**Files:**
- No code changes expected unless a test helper needs a tiny adjustment.

- [ ] **Step 1: Run the focused dreaming tests**

Run:

```bash
bun test packages/daemon/test/dreaming/query-searchability.test.ts
bun test packages/daemon/test/dreaming/cycle.test.ts
```

Expected: green.

- [ ] **Step 2: Run the daemon package typecheck slice**

Run: `bun run typecheck`

Expected: green, with no new TypeScript errors in `packages/daemon/src/dreaming/*` or the test imports.

- [ ] **Step 3: Check for unintended behavior shifts**

Verify that the existing negative-cache tests still pass and that the P4 queue cap behavior is unchanged. The new gate should only reduce queued `research_query` actions; it should not affect `resolve_contradiction`, P0 bailouts, or the P5 research execution path.

- [ ] **Step 4: Commit if verification surfaced any test-only tweaks**

If a helper or import needed adjustment during verification, commit it with the smallest message that describes the tweak, for example:

```bash
git add <touched-files>
git commit -m "test(dreaming): cover unsearchable query gate"
```

### Task 4: Runtime follow-up check on the deployed daemon

**Files:**
- No code changes expected.

- [ ] **Step 1: Restart the daemon only if the local runtime needs a fresh load**

If the daemon is running with stale code, restart it through the normal operator path:

```bash
bun packages/cli/bin/penumbra.ts stop
bun packages/cli/bin/penumbra.ts start --detach
```

If you are only running tests, do not restart anything.

- [ ] **Step 2: Confirm the new gate is visible in logs**

Exercise one dreaming cycle in a local dev environment and confirm that internal titles are logged as skipped with the new `[dream-p4] skipping unsearchable query title` message.

- [ ] **Step 3: Confirm no queue regression**

Check that `dream_actions` still receives ordinary searchable titles and that the total number of queued `research_query` actions drops only for the internal-title cases from the spec.

### Out of scope for this plan

- Local LLM query rewriting
- Embedding-space concept extraction
- New config files for allowlists
- Changes to Firecrawl billing or negative-cache behavior

This plan deliberately stops at the cheapest useful gate. If the team later wants better query quality, that should be a separate follow-up plan that layers a rewriter on top of this guard rather than replacing it.
