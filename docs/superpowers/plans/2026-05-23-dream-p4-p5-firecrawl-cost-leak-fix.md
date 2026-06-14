# Dream P4/P5 Firecrawl Cost-Leak Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop repeated Firecrawl billing for empty-filter searches by caching negative P5 results, backing off recently failed P4 queries, and pushing domain filters into the Firecrawl query string.

**Architecture:** Reuse the existing `dream_research_cache` table instead of introducing a new persistence path. P5 writes a negative sentinel row when Firecrawl returns no usable results, and P4 consults that same cache key shape before minting another `research_query` action. Firecrawl search requests keep the existing client-side domain filter, but also prepend a `site:` clause so the upstream request is narrower before billing happens.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing SQLite migration helpers in `packages/core`, daemon dreaming/research code, and the Firecrawl adapter in `packages/daemon`.

---

### Task 1: Verify and finish negative-cache schema support and P5 sentinel write/read

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/daemon/src/dreaming/research.ts`
- Test: `packages/daemon/test/dreaming/research.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a `bun:test` case that uses `runP5Phase` on two cycles for the same `(project_id, query)` where the first run gets Firecrawl results that are filtered down to empty and the second run should hit the cache instead of calling the adapter again.

```ts
import { expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, loadSqliteVec } from '@penumbra/core';
import { runP5Phase } from '../../src/dreaming/research.js';

test('P5 caches empty filtered Firecrawl results as a negative sentinel', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);

  db.prepare("INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle1', 1, 'cron', 10, 'running', '[]')").run();
  db.prepare("INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle2', 2, 'cron', 10, 'running', '[]')").run();
  db.prepare("INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a1', 'cycle1', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"Concurrent boot flow assertions\"}')").run();
  db.prepare("INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES('a2', 'cycle2', 'P4', 'research_query', 0.9, 'queued', '[\"proj1\"]', '{\"query\":\"Concurrent boot flow assertions\"}')").run();

  const search = mock(async () => []);
  const deps = {
    projectRegistry: { get: () => ({ dreaming: { research_provider: 'firecrawl', allowed_domains: ['example.com'] } }) },
    getResearchAdapter: () => ({ search }),
  };

  await runP5Phase(db, 'cycle1', {} as any, deps as any);
  await runP5Phase(db, 'cycle2', {} as any, deps as any);

  expect(search.mock.calls.length).toBe(1);
  const cacheKey = createHash('sha256').update('Concurrent boot flow assertions|Concurrent boot flow assertions').digest('hex');
  const cacheRow = db.prepare('SELECT is_negative FROM dream_research_cache WHERE cache_key=?').get(cacheKey) as { is_negative: number } | null;
  expect(cacheRow?.is_negative).toBe(1);
});
```

Add a schema test that the migration path exposes `is_negative INTEGER NOT NULL DEFAULT 0` and a partial index on negative rows.

```ts
it('adds the negative-cache column and index', async () => {
  const schema = await getDreamSchemaSql();
  expect(schema).toContain('ADD COLUMN is_negative INTEGER NOT NULL DEFAULT 0');
  expect(schema).toContain('idx_dream_research_cache_negative');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
bun test packages/daemon/test/dreaming/research.test.ts
```

Expected: the new negative-cache assertions fail until the cache write/read path is finished.

- [ ] **Step 3: Implement the minimal schema and P5 cache path**

If `packages/core/src/db/schema.ts` is missing the additive migration, add it there; otherwise keep the existing `addColumnIfMissing(...)` + partial index and move on:

```sql
ALTER TABLE dream_research_cache ADD COLUMN is_negative INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dream_research_cache_negative
  ON dream_research_cache(cache_key) WHERE is_negative = 1;
```

In `packages/daemon/src/dreaming/research.ts`, when `runP5Phase` sees `searchResults.length === 0` or a post-filtered empty set, write the sentinel before marking the action failed:

```ts
await db.run(
  `INSERT OR REPLACE INTO dream_research_cache
   (cache_key, project_id, query, url, markdown, is_negative, expires_at)
   VALUES (?, ?, ?, ?, '', 1, ?)`,
  [cacheKey, projectId, query, query, Date.now() + negativeCacheTtlMs],
);
```

Before calling the adapter, look up the existing cache row and skip the adapter when `is_negative === 1` and `expires_at > now`, updating `decided_by='negative-cache-hit'` so the failure is visible in forensics.

- [ ] **Step 4: Run the focused test again**

Run:

```bash
bun test packages/daemon/test/dreaming/research.test.ts
```

Expected: pass, with adapter call count fixed at 1 across the two runs and the sentinel row present in `dream_research_cache`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/daemon/src/dreaming/research.ts packages/daemon/test/dreaming/research.test.ts
git commit -m "fix: cache empty dream research results"
```

---

### Task 2: Add P4 backoff for recently failed research queries

**Files:**
- Modify: `packages/daemon/src/dreaming/cycle.ts`
- Test: `packages/daemon/test/dreaming/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that seeds a negative cache row for a `(project_id, query)` pair and verifies the P4 cycle does not mint a new `research_query` action for that title during the TTL window.

```ts
it('skips minting research_query for recently failed queries', async () => {
  await seedNegativeResearchCache({
    projectId: 'project-1',
    query: 'Parallel boot actions using allSettled',
    expiresAt: Date.now() + 3_600_000,
  });

  const minted = await runDreamCycleOnce({
    projectId: 'project-1',
    topT2Titles: ['Parallel boot actions using allSettled'],
  });

  expect(minted).toHaveLength(0);
});
```

If the test file does not already have a helper for seeding a negative row, inline the insert the same way `research.test.ts` already seeds `dream_research_cache` rows:

```ts
db.prepare(
  "INSERT INTO dream_research_cache(cache_key, provider, project_id, url, markdown, fetched_at, expires_at, is_negative) VALUES(?, 'negative', ?, ?, '', ?, ?, 1)"
).run(cacheKey, projectId, query, Date.now(), Date.now() + 3_600_000);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
bun test packages/daemon/test/dreaming/cycle.test.ts
```

Expected: the cycle still mints the action because it does not yet consult negative cache rows.

- [ ] **Step 3: Implement the minimal backoff check**

In `packages/daemon/src/dreaming/cycle.ts`, after sanitizing the title into a search query and before minting the `research_query` action, compute the same cache key shape used by P5 search (`hashQuery(query, query)`) and query `dream_research_cache` for a live negative row.

```ts
const cacheKey = hashQuery(query, query);
const negativeHit = await db.get(
  `SELECT 1
   FROM dream_research_cache
   WHERE cache_key = ? AND is_negative = 1 AND expires_at > ?`,
  [cacheKey, Date.now()],
);

if (negativeHit) {
  continue;
}
```

Keep the TTL window the same as P5 negative caching so the behavior stays aligned.

- [ ] **Step 4: Run the focused test again**

Run:

```bash
bun test packages/daemon/test/dreaming/cycle.test.ts
```

Expected: pass, with no new `research_query` action minted for the failed query.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/dreaming/cycle.ts packages/daemon/test/dreaming/cycle.test.ts
git commit -m "fix: back off repeated dream research queries"
```

---

### Task 3: Keep Firecrawl query shaping and regression coverage tight

**Files:**
- Modify: `packages/daemon/src/research/firecrawl-adapter.ts`
- Test: `packages/daemon/test/research/firecrawl-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add or keep a test that verifies the transport receives a query containing `site:react.dev` when `allowed_domains` is provided, and that no `site:` prefix is added when `allowed_domains` is empty.

```ts
it('prepends site filters when allowed domains are provided', async () => {
  const transport = mock(async (payload) => payload);
  const adapter = new FirecrawlAdapter({}, transport);

  await adapter.search({
    query: 'hooks rules',
    allowedDomains: ['react.dev'],
  });

  expect(transport.mock.calls[0][0].query).toContain('site:react.dev');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
bun test packages/daemon/test/research/firecrawl-adapter.test.ts
```

Expected: the transport still receives the unmodified query.

- [ ] **Step 3: Implement the query shaping**

In `packages/daemon/src/research/firecrawl-adapter.ts`, build a single query string that prefixes the user query with a `site:` disjunction when `allowedDomains` is non-empty, then keep the existing client-side post-filter in place. The current implementation already does this; this task is to preserve it while the P5/P4 changes land.

```ts
const domainClause = allowedDomains.length
  ? `(${allowedDomains.map((domain) => `site:${domain}`).join(' OR ')}) `
  : '';

const transportQuery = `${domainClause}${query}`;
```

Send `transportQuery` to Firecrawl, and leave the downstream result filter unchanged.

- [ ] **Step 4: Run the focused test again**

Run:

```bash
bun test packages/daemon/test/research/firecrawl-adapter.test.ts
```

Expected: pass, with `site:` present only when domains were provided.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/research/firecrawl-adapter.ts packages/daemon/test/research/firecrawl-adapter.test.ts
git commit -m "fix: narrow firecrawl searches by allowed domains"
```

---

### Task 4: Verify regression coverage for the original P5 success path

**Files:**
- Modify: `packages/daemon/test/dreaming/research.test.ts`
- Verify: `packages/daemon/test/dreaming/research.test.ts`, `packages/daemon/test/dreaming/cycle.test.ts`, `packages/daemon/test/research/firecrawl-adapter.test.ts`

- [ ] **Step 1: Add a success-path regression test**

Keep the existing P5 success path intact by asserting that a non-empty search still writes a positive cache row and does not get mistaken for a negative sentinel.

```ts
it('keeps positive P5 cache rows unchanged', async () => {
  const search = mock(async () => [{ url: 'https://example.com', markdown: 'ok' }]);
  const adapter = { search };

  const result = await runP5Research({
    projectId: 'project-1',
    query: 'Concurrent boot flow assertions',
    allowedDomains: [],
    researchAdapter: adapter,
  });

  expect(result.status).toBe('completed');
  expect(result.cacheRow.isNegative).toBe(0);
});
```

- [ ] **Step 2: Run the full focused test set**

Run:

```bash
bun test packages/daemon/test/dreaming/research.test.ts packages/daemon/test/dreaming/cycle.test.ts packages/daemon/test/research/firecrawl-adapter.test.ts
```

Expected: all three suites pass together, confirming the negative cache does not break the existing success path.

- [ ] **Step 3: Run the repo-level type check**

Run:

```bash
bun run typecheck
```

Expected: pass. This also scrubs stale `dist/*` outputs before TypeScript checks, so do not treat a clean typecheck as optional.

- [ ] **Step 4: Smoke the daemon behavior after deployment**

After landing and restarting or reloading only if your local workflow requires it:

```bash
SELECT COUNT(*) FROM dream_research_cache WHERE is_negative = 1;
```

Expected: the count rises on live traffic, and the same query should not produce repeated Firecrawl bills within the TTL window.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/test/dreaming/research.test.ts
git commit -m "test: cover dream research negative cache regression"
```

---

### Follow-up Checks

1. Confirm `research_provider: firecrawl` can be re-enabled for a single project after the patch without the same `(project_id, query)` repeatedly billing every minute.
2. If live traffic still shows repeats, inspect whether the negative-cache lookup key in P4 and the P5 cache write are using the same `hashQuery(query, query)` shape for search-only actions.
3. If a schema migration fails on an existing database, keep the rollout additive and do not attempt a destructive reset; the rollback path is still `research_provider: off`.
