# Plan — Dream P4/P5 Firecrawl cost-leak fix

**Spec:** `docs/superpowers/specs/2026-05-23-dream-p4-p5-firecrawl-cost-leak.md`
**Authored:** 2026-05-23
**Predecessor commit:** `7857404a` (P5 cache-key lookup-shape fix; covers success path only)
**Theme:** harden the dreamer — close the empty-result re-bill loop so Firecrawl can be re-enabled.

## Overview

Two coupled changes plus one adapter improvement, gated by a single additive schema migration:

1. P5 writes a sentinel row to `dream_research_cache` when results filter to empty (today's leak: catch block marks the action `failed` without any cache write, so next minute the same Firecrawl bill recurs).
2. P4 consults that sentinel before minting a `research_query` (today's leak: dedup checks queued/approved, not failed — re-minting every cycle).
3. `FirecrawlAdapter.search` passes `site:` filters server-side when `allowed_domains` is set (defense-in-depth; current implementation is client-side post-filter, so Firecrawl is already billed by the time we filter).

Phases 3 and 4 are independent (different files) and can run in parallel after the schema migration lands. Phase 2 (adapter) is independent of all of them.

## Phase 1 — Schema: `dream_research_cache.is_negative`

Dispatch graph: 1.1

### Task 1.1 — Additive `is_negative` column + partial index

```yaml meta
id: "1.1"
files:
  - packages/core/src/db/schema.ts
  - packages/core/test/db/schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: ["2.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

**TDD:**

1. Add a new test in `packages/core/test/db/schema.test.ts` (create the file if absent; mirror existing schema-test conventions) that:
   - Opens a fresh in-memory DB, runs schema, asserts `PRAGMA table_info(dream_research_cache)` contains a row `{ name: 'is_negative', type: 'INTEGER', notnull: 1, dflt_value: '0' }`.
   - Asserts the partial index `idx_dream_research_cache_negative` exists via `SELECT name FROM sqlite_master WHERE type='index'`.
   - Runs the schema **twice** against the same DB (idempotency check) and asserts neither call throws.
   - Run the test — expect it to FAIL (column does not exist yet).
2. In `packages/core/src/db/schema.ts` around the `dream_research_cache` block (line 935-949), wrap the additive change in the same idempotency pattern used elsewhere in the file: after the `CREATE TABLE IF NOT EXISTS`, run `ALTER TABLE dream_research_cache ADD COLUMN is_negative INTEGER NOT NULL DEFAULT 0` inside a try/catch on "duplicate column" so old DBs gain the column on next boot and new DBs already have it via a no-op (or simply add the column to the `CREATE TABLE` body — pick whichever matches the file's existing precedent and apply the ALTER for older DBs).
3. Add `CREATE INDEX IF NOT EXISTS idx_dream_research_cache_negative ON dream_research_cache(cache_key) WHERE is_negative = 1`.
4. Re-run the test — expect it to PASS.
5. Run the full `@penumbra/core` test suite to confirm no regression on existing dream tests (e.g. `dream-action-revert.test.ts`).
6. Commit: `feat(core-schema): dream_research_cache.is_negative column + partial index (P5 negative cache)`.

**Verification:** `bun --cwd packages/core test schema` shows the new test passing; full core suite green.

Integration: Land directly on the branch. Subsequent phases assume the column exists. No rebuild needed of downstream packages until they reference the column.

## Phase 2 — Firecrawl: server-side `site:` filter (parallel to Phase 1)

Dispatch graph: 2.1

### Task 2.1 — Inject `(site:d1 OR site:d2 …)` prefix when `allowed_domains` is set

```yaml meta
id: "2.1"
files:
  - packages/daemon/src/research/firecrawl-adapter.ts
  - packages/daemon/test/research/firecrawl-adapter.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: ["1.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**TDD:**

1. Add a test to `packages/daemon/test/research/firecrawl-adapter.test.ts` (create the file if absent; use the test-transport injection pattern already supported by `FirecrawlAdapter`'s second constructor arg):
   - Given a mock transport whose `search` records the args it received, when `FirecrawlAdapter.search({ query: 'allSettled', allowed_domains: ['react.dev', 'mdn.io'] })` is called, assert `transport.search` was called with a query string that contains `site:react.dev OR site:mdn.io` (substring assertion is fine; ordering inside the parens is not load-bearing).
   - Add a second test for the no-allowed-domains case: assert the transport receives the bare `allSettled` query unchanged.
   - Run — expect FAIL.
2. In `packages/daemon/src/research/firecrawl-adapter.ts:84-104`, before delegating to `this.transport.search`, build:
   - `const sitePrefix = (args.allowed_domains?.length ?? 0) > 0 ? '(' + args.allowed_domains.map(d => 'site:' + d).join(' OR ') + ') ' : ''`
   - Pass `{ query: sitePrefix + args.query, max_pages: args.max_pages }` to the transport.
   - Keep the existing client-side post-filter (Firecrawl honors `site:` but can be loose; defense in depth).
3. Re-run — expect PASS.
4. Sanity-run the daemon test suite locally to confirm no other consumer broke.
5. Commit: `feat(firecrawl-adapter): server-side site filter when allowed_domains set`.

Integration: Independent of Phase 1. Land on the branch; no rebuild of `@penumbra/core` needed.

## Phase 3 — P5: negative-result cache write + read

Dispatch graph: 3.1

### Task 3.1 — Sentinel row on empty/throw + short-circuit on hit

```yaml meta
id: "3.1"
files:
  - packages/daemon/src/dreaming/research.ts
  - packages/daemon/test/dreaming/research.test.ts
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: ["4.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

**TDD:**

1. Add a test to `packages/daemon/test/dreaming/research.test.ts`: with a fake `WebResearchAdapter` whose `search` returns `[]`, queue one P4 `research_query` action, run `runP5Phase` twice (same query, both within TTL), assert:
   - `fakeAdapter.searchCalls === 1` (second call short-circuited).
   - `SELECT is_negative FROM dream_research_cache WHERE cache_key=?` returns 1 for the lookup-shape key.
   - The first action transitioned to `failed`; the second action also transitioned to `failed` with `decided_by='negative-cache-hit'` (or similar — pick a stable string and assert it).
   - Run — expect FAIL.
2. Add a second test: client-side filter empties the results (adapter returns rows whose domains don't match `allowed_domains`). Expect identical behavior: sentinel cached, second call short-circuits.
3. In `packages/daemon/src/dreaming/research.ts`:
   - Read path: after the existing `SELECT * FROM dream_research_cache WHERE cache_key=?`, when `cached?.is_negative === 1` AND `cached.expires_at > now`, mark the action failed with `decided_by='negative-cache-hit'` (extend the UPDATE statement; add the column to the `decided_by` write) and `continue`.
   - Write path: in the catch block (line 122) and in the explicit empty branch (the `throw new Error('no results')` site at line 94), before the `UPDATE … status='failed'`, INSERT (with `INSERT OR REPLACE`) a sentinel row keyed on `cacheKey` with `provider='negative'`, `project_id`, `url=resolvedUrl`, `query_hash=cacheKey`, `title=''`, `markdown=''`, `fetched_at=now`, `expires_at=now+negativeCacheTtlMs`, `source_billed_usd=0`, `is_negative=1`. Also write a sentinel when the post-fetch `domainGated` array is empty (after the for-loop scoring, before the action transitions to `completed` with zero P5 enrichments) — same shape.
   - Pull `negativeCacheTtlMs` from `config.negativeCacheTtlMs ?? 3_600_000`; add the field to `DreamConfig` (in `packages/daemon/src/dreaming/config.ts`) with a sensible default.
4. Re-run tests — expect PASS.
5. Run the wider daemon test suite (focus: dreaming tests) — must stay green; the existing `7857404a` regression test must still pass.
6. Commit: `feat(dreaming-research): P5 negative-result cache short-circuits empty queries`.

Integration: Cherry-pick onto the branch after Phase 1. Run `bun --cwd packages/daemon test dreaming` end-to-end before continuing.

## Phase 4 — P4: backoff against recently-failed queries (parallel to Phase 3)

Dispatch graph: 4.1

### Task 4.1 — Consult `dream_research_cache.is_negative` before minting

```yaml meta
id: "4.1"
files:
  - packages/daemon/src/dreaming/cycle.ts
  - packages/daemon/test/dreaming/cycle.test.ts
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: ["3.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

**TDD:**

1. Add (or extend, if a `cycle.test.ts` already exists) `packages/daemon/test/dreaming/cycle.test.ts`. Required cases:
   - **Backoff hit:** a project with `research_provider='firecrawl'` and two t2 titles. Pre-seed `dream_research_cache` with `is_negative=1, expires_at=now+1h` rows keyed on `hashQuery(query, query)` for both. Run a P4 phase. Assert **zero** `dream_actions` rows with `phase='P4' AND action_type='research_query'` were inserted.
   - **Backoff miss (expired sentinel):** same setup but `expires_at=now-1h`. Assert two actions ARE inserted.
   - **No-sentinel control:** no rows in the cache. Assert two actions ARE inserted (current behavior preserved).
   - Run — expect FAIL on the first case.
2. In `packages/daemon/src/dreaming/cycle.ts` inside the research-seeding loop (lines 459-477), after computing `const query = sanitizeTitleForQuery(memory.title)` and before the queueCount check:
   - Import `crypto` and the same `hashQuery` helper used by `research.ts` (export it from `research.ts` or duplicate the 2-line function — duplication is fine here, both sites use the same `(query, query)` shape).
   - Run `const negKey = hashQuery(query, query)` and `SELECT 1 FROM dream_research_cache WHERE cache_key=? AND is_negative=1 AND expires_at > ?` with `(negKey, Date.now())`. If a row exists, `continue` (skip minting).
   - Optional log line for visibility: `console.log('[dream-p4] skipping query due to negative-cache hit', { project_id, query })` — keep it light.
3. Re-run tests — expect PASS.
4. Run the full daemon test suite once.
5. Commit: `feat(dreaming-cycle): P4 backoff skips queries with recent negative-cache sentinel`.

Integration: Cherry-pick onto the branch after Phase 1. Order with Phase 3 doesn't matter (different files), but both must land before smoke.

## Phase 5 — Smoke & re-enable

Dispatch graph: 5.1 → 5.2 → 5.3

### Task 5.1 — Local boot + dist rebuild + launchd kickstart

```yaml meta
id: "5.1"
files: []
file_scope: extend-shared
depends_on: ["3.1", "4.1", "2.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

Build the daemon (`bun --cwd packages/daemon run build` or repo-root equivalent), kickstart `dev.penumbra.daemon`, confirm pid changed and `journalctl`-equivalent shows clean startup. **No re-enable yet.**

### Task 5.2 — Single-project smoke (penumbra only)

```yaml meta
id: "5.2"
files:
  - ~/.penumbra/projects.yaml
file_scope: extend-shared
depends_on: ["5.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

User-gated step (blast radius: real $$ if anything regressed). With the user's go-ahead:
1. Edit `~/.penumbra/projects.yaml` to set `research_provider: firecrawl` on the `penumbra` project only. Use the comment-on-own-line workaround per `[[project-projects-yaml-inline-comment-parser-quirk-2026-05-23]]`.
2. `daemon_reload_config`.
3. Wait 2 dream cycles (~2 min).
4. `sqlite3 ~/.penumbra/penumbra.sqlite "SELECT COUNT(*) FROM dream_research_cache WHERE is_negative=1 AND project_id=(SELECT project_id FROM projects WHERE name='penumbra');"` — should be ≥ 1 if any P5 attempt empties.
5. `sqlite3 ~/.penumbra/penumbra.sqlite "SELECT COUNT(*) FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status='failed' AND decided_at > strftime('%s','now')*1000 - 600000;"` — count must stop growing across two consecutive checks (steady-state, not strictly zero — first cycle of a new query still issues one Firecrawl call before caching the negative).
6. Check the Firecrawl console — at most 1 search per distinct query in the last 10 minutes.

### Task 5.3 — Roll out to remaining 4 projects (or roll back)

```yaml meta
id: "5.3"
files:
  - ~/.penumbra/projects.yaml
file_scope: extend-shared
depends_on: ["5.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

If 5.2 is clean: flip `research_provider: firecrawl` on the other 4 projects, `daemon_reload_config`, watch for 5 minutes. If anything regresses (Firecrawl console shows repeated identical queries, or `dream_research_cache` doesn't grow `is_negative=1` rows when expected): revert to `off`, re-disable, write a follow-up note.

Integration: Manual smoke + handoff memory. Write `[[project-dream-p4-p5-firecrawl-cost-leak-resolved-2026-05-23]]` once 5.3 is green.

## Validator gate

After this file is written, run `penumbra plan validate docs/superpowers/plans/2026-05-23-dream-p4-p5-firecrawl-cost-leak.md`. Fix any reciprocity / cycle / agent-membership issues before dispatching.
