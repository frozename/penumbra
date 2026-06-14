# Spec — Dream P4/P5 Firecrawl cost-leak fix

**Status:** spec, awaiting `/write-plan`
**Authored:** 2026-05-23
**Theme:** harden the dreamer (Task #5 from `docs/notes/maestro-continuation-2026-05-23-pm-late.md`)
**Predecessor:** commit `7857404a` — P5 cache-key lookup-shape fix (covers success path only)

## Problem

P5 dream research re-bills Firecrawl every cycle for queries whose results filter to empty:

1. P4 mints `research_query` actions from the top-2 most-recent t2 titles for each project with `research_provider != off`. Dedup is by `target_ids` (project) for **queued/approved** rows only — once an action transitions to `failed`, it no longer matches and the same `(project_id, query)` is re-minted next cycle.
2. P5 dequeues the action, calls `researchAdapter.search({ query, allowed_domains })`. Firecrawl `/v1/search` body sends only `query` + `limit` — domain filtering happens **client-side** in `FirecrawlAdapter.search` (`packages/daemon/src/research/firecrawl-adapter.ts:96`). Firecrawl is already billed by the time we filter.
3. Post-filter, `searchResults.length === 0` → `throw new Error('no results')` → catch block at `packages/daemon/src/dreaming/research.ts:122` marks the action `failed` with **no cache write**.
4. Next minute: cycle fires, P4 re-mints same queries (same top-2 t2 titles), P5 re-bills Firecrawl, filter empties, throw, repeat.

Forensic evidence (last ~24h on the live DB): **3,004 failed P4 actions** vs **10 completed**. Two specific titles ("Concurrent boot flow assertions", "Parallel boot actions using allSettled") cycled alternately every ~60s in the Firecrawl console screenshot.

Mitigation in place: `research_provider: off` on all 5 projects in `~/.penumbra/projects.yaml`. Cannot re-enable until this lands.

## Scope

In:

- P5 negative-result cache (sentinel cache row when results empty after filter).
- P4 backoff against recently-failed `(project_id, query)` pairs.
- Firecrawl adapter passes site filter server-side when `allowed_domains` is set.
- Regression tests for each.

Out:

- The unrelated P1 dedup bypass (Task #7) — separate spec.
- Cache TTL revisit, embedding-based dedup, Firecrawl alternatives. These can ride on a later pass.

## Design

### P5 negative-result cache

Reuse `dream_research_cache` instead of adding a new table — the cache_key already gives us `(project_id-via-row, query, url)` identity.

- Add column `is_negative INTEGER NOT NULL DEFAULT 0` to `dream_research_cache` via additive migration (idempotent ALTER TABLE pattern already used in the repo). `markdown=''` alone is ambiguous — explicit column is clearer and indexable.
- Sentinel TTL: 1 hour (configurable via `DreamConfig.negativeCacheTtlMs`, default 3_600_000). Short enough to recover quickly if upstream coverage changes; long enough to break the 60s cycle.
- Write path: in the P5 catch block (`research.ts:122`), before marking `failed`, INSERT a sentinel row keyed on `cacheKey` (the lookup-shaped key already computed at line 62) with `is_negative=1`, `markdown=''`, `expires_at=now+ttlMs`. Use `INSERT OR REPLACE` so a re-attempt within TTL refreshes rather than crashing on PK collision.
  - Also write a sentinel on the "no results" `throw` path before the catch (or just let it fall through — the catch already gets the throw; one write site is enough).
- Read path: when `cached.is_negative === 1` AND `cached.expires_at > now`, skip the adapter call **and** skip emitting P5 enrichment actions; mark P4 action `failed` with `decided_by='negative-cache-hit'` (visible in forensics).
- Edge: lookup currently uses `cacheKey = hashQuery(query, resolvedUrl)`. For pure search actions `resolvedUrl = query`. Same key shape for negative writes — they match.

### P4 backoff

Add a guard before re-minting any `research_query` action: if a `(project_id, query)` pair has **failed** within the last N hours, skip.

Two storage options considered:

- **Reuse `dream_research_cache` with `is_negative=1`.** Same key shape used at P5 — query the cache from P4 before minting. Pros: no new schema, fewer moving parts. Cons: couples P4's "did we recently fail" check to P5's cache-key shape (currently `hashQuery(query, query)` for searches), which is brittle if scrape actions are ever added to P4.
- **New `dream_research_failures` table** with `(project_id, query)` PK, `last_failed_at`, `fail_count`. Pros: clear contract, easy to extend with reason codes. Cons: another table.

**Decision: reuse `dream_research_cache`.** P4 only mints search-shape queries (no URL in payload at P4 generation — confirmed at `cycle.ts:475` only writes `{query, source_memory_id}`). The cache_key shape is stable for that path. Save the new table for when scrape-shape P4 actions exist.

- In `cycle.ts` P4 loop, after computing `query = sanitizeTitleForQuery(memory.title)`, compute the same `cacheKey = hashQuery(query, query)` and query `dream_research_cache` for `is_negative=1 AND expires_at > now`. If hit, skip (do not mint the action). Log a counter (sentry/console) for visibility.
- TTL for the backoff window is the same as the negative-cache TTL — they're conceptually the same window.

### Server-side site filter (Firecrawl)

When `allowed_domains` is provided to `FirecrawlAdapter.search`, prepend `(site:d1 OR site:d2 OR ...)` to the query string sent to `/v1/search`. Firecrawl honors Google-style site operators.

- Add to `FirecrawlAdapter.search`: build the modified query, send that to transport. Keep the client-side post-filter as a defense-in-depth (Firecrawl can be loose).
- Test: assert transport called with query containing `site:` prefix when allowed_domains set; not when not set.

### Schema migration

Additive only:

```sql
ALTER TABLE dream_research_cache ADD COLUMN is_negative INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dream_research_cache_negative
  ON dream_research_cache(cache_key) WHERE is_negative = 1;
```

Existing rows default to `is_negative=0` — no behavior change for the success path.

## Acceptance criteria

1. With Firecrawl returning empty results (or filtered to empty), the **second** P5 invocation for the same `(project_id, query)` within TTL must NOT call the adapter. Test asserts adapter `search` call count = 1 across two cycles.
2. P4 with a project that has only "recently-failed" queries at the top of its t2_memories must mint **zero** new `research_query` actions for those queries during the backoff window.
3. After both fixes are live and firecrawl is re-enabled on penumbra, `SELECT COUNT(*) FROM dream_research_cache WHERE is_negative=1` grows; no more than 1 Firecrawl bill per `(query, TTL window)`.
4. Existing P5 success-path tests still pass (regression bar for commit `7857404a`).
5. Adapter unit test: `search({allowed_domains:['react.dev']})` causes transport to receive query containing `site:react.dev`.

## Smoke plan

Post-land, on penumbra project only:

1. `~/.penumbra/projects.yaml` → set `research_provider: firecrawl` (with the inline-comment workaround per `[[project-projects-yaml-inline-comment-parser-quirk-2026-05-23]]`).
2. `daemon_reload_config`.
3. Wait 2 dream cycles (~2 min).
4. `SELECT COUNT(*) FROM dream_research_cache WHERE is_negative=1` — should be ≥ 1 if any query returns no results.
5. Firecrawl console — at most 1 search per distinct query per hour.
6. If clean: enable other 4 projects.
7. If billing still leaks: roll back via `research_provider: off` + `daemon_reload_config` (no schema rollback needed; new column stays).

## Risk / rollback

- Additive migration → rollback path is `research_provider: off`. Don't have to undo the schema.
- TTL too short → adapter still re-billed but at most once per hour per query (≥60× improvement over current).
- TTL too long → if upstream content appears, we won't notice for up to an hour. Acceptable given billing impact.
- The negative cache also short-circuits **legitimately empty** queries — if a user fixes their `allowed_domains` mid-window, the next P4/P5 still skips. Operator override: `DELETE FROM dream_research_cache WHERE is_negative=1 AND project_id=?` flushes the project's negative cache.

## Files in scope

- `packages/core/src/db/schema.ts` — additive ALTER + index (around line 947).
- `packages/daemon/src/dreaming/research.ts` — negative cache read + write in P5.
- `packages/daemon/src/dreaming/cycle.ts` — backoff check in P4 (lines 459-477).
- `packages/daemon/src/research/firecrawl-adapter.ts` — server-side site filter (lines 84-104).
- `packages/daemon/test/dreaming/research.test.ts` — new tests for negative cache.
- `packages/daemon/test/dreaming/cycle.test.ts` (or `pc2-cluster.test.ts` neighbor) — new test for P4 backoff.
- `packages/daemon/test/research/firecrawl-adapter.test.ts` — new test for site-filter prefix.

## Cross-refs

- `[[project-dream-p5-research-cache-key-mismatch-2026-05-23]]` — the partial fix this builds on.
- `[[project-projects-yaml-inline-comment-parser-quirk-2026-05-23]]` — relevant during smoke.
- Continuation note: `docs/notes/maestro-continuation-2026-05-23-pm-late.md` (Task #5 section).
