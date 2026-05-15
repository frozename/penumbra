# Per-Chain-Root Fair Claim Queue — Implementation Plan

Date: 2026-05-06
Spec: `docs/superpowers/specs/2026-05-06-fair-claim-queue-design.md`
Depends on: cross-repo plan-runtime V1 (schema v10→v11) — assumed shipped before this plan starts.
Status: Ready

> **For agentic workers:** REQUIRED SUB-SKILL: `penumbra:dispatching` (recommended) or `penumbra:executing-plans` to implement task-by-task.

## Pre-flight

- Tests: `import { expect, test } from 'bun:test';` Real sqlite via `loadSqliteVec` + `migrate(db, { embeddingDim: 384 })` from `@penumbra/core`. Mirror migration test layout at `packages/core/test/db/migration-9-to-10.test.ts` and `packages/core/test/db/migration-10-to-11.test.ts` (the latter ships with cross-repo plan-runtime V1).
- Daemon restarts: Phase 1 only (v11→v12). `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`. Phases 2–3 are pure code on top of v12 schema and require no further restart.
- Style siblings: `2026-05-05-cross-repo-plan-runtime.md` (8-phase template), `2026-05-04-maestro-behavior-hooks.md` (smaller, research-gated). Validator at `bun packages/cli/bin/penumbra.ts plan validate` enforces reciprocity, agent membership, file_scope-vs-disk, dep-cycle freedom.
- Conventional commits, neutral text, no AI/tool authorship. Reconciler unblocked as of `002571e`; auto-FF expected, manual cherry-pick fallback from `agent/<id>` worktrees if a phase races a maestro commit.
- Claim-path location reference: worker pulls candidates via `client.listHandoffs({ statuses: ['approved', 'redirected'] })` (`packages/agentchat/bin/agentchat-worker.ts:1025`); daemon serves them via `HandoffReader.listByStatus` (`packages/core/src/readers/handoff.ts:25`); per-row claim is atomic via `HandoffWriter.claimDispatch` (`packages/core/src/writers/handoff.ts:142`). The new ORDER BY lives at the listing query, not at the per-row UPDATE.

## Dispatch graph (this plan, executed)

```
1.1
2.1 ∥ 2.2 → 2.3
3.1
```

Phase 1 ships the schema atomically. Phase 2 lights up population + claim ordering + telemetry on top of v12. Phase 3 closes with a daemon-level interleave smoke.

---

## Phase 1 — Schema bump v11 → v12 + backfill

Single atomic migration: add `root_handoff_id`, covering index, and in-transaction backfill of existing rows. Dispatch graph: `1.1`

### Task 1.1 — Schema v11 → v12 + in-tx backfill + migration test

```yaml meta
id: '1.1'
files:
  - packages/core/src/db/schema.ts
  - packages/core/test/db/migration-11-to-12.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: substantial
risk_class: bootstrap-touching
```

Bump `SCHEMA_VERSION` 11 → 12. In `applySchema` / migration helper:

```sql
ALTER TABLE handoffs ADD COLUMN root_handoff_id TEXT;
CREATE INDEX IF NOT EXISTS idx_handoffs_root_status
  ON handoffs(status, root_handoff_id);
```

Column is nullable on the schema; the population logic in Phase 2 enforces the not-null contract on insert. Use `addColumnIfMissing` (already used at `packages/core/src/db/schema.ts:464` for `parent_handoff_id`) so the migration is idempotent across re-applies.

In-tx backfill, same migration step:

1. For each row with `root_handoff_id IS NULL`, walk `parent_handoff_id` until `parent_handoff_id IS NULL` → set `root_handoff_id = <terminal handoff_id>`.
2. Cap walk depth at 16. On overflow, set `root_handoff_id = handoff_id` (self-root) and emit a single warning to stderr citing the offending `handoff_id`.
3. Orphaned parent (referenced but row missing): self-root + warning, same fallback.
4. Backfill is one batched UPDATE per visit-tier (BFS by depth) inside the migration tx so the column is never observed NULL post-migration.

**Tests** (in `packages/core/test/db/migration-11-to-12.test.ts`, mirroring the v10→v11 test):
1. Pre-seed v11 db with 4 rows: a self-rooted root R1, child C1 of R1, grandchild G1 of C1, and an unrelated self-rooted R2. Run migrate. Assert `root_handoff_id` populated: `R1=R1`, `C1=R1`, `G1=R1`, `R2=R2`.
2. Idempotency: re-run migrate; column values unchanged; no duplicate index errors.
3. Depth-cap fallback: seed a synthetic 17-deep chain; assert deepest row gets self-rooted with warning emitted.
4. Orphaned parent: row with `parent_handoff_id` pointing at a deleted row → self-rooted with warning.
5. Index visible in `sqlite_master` post-migrate.
6. Schema version reads `'12'`.

**Commit:** `feat(schema): handoffs.root_handoff_id + covering index, bump SCHEMA_VERSION to 12`

**Integration:** `bun test packages/core/test/db/migration-11-to-12`. Restart daemon (schema bump) — `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`.

---

## Phase 2 — Root population at insert + fair-queue ordering + telemetry

Three independent edits on top of the v12 schema. Population (writer) and ordering (reader) are file-disjoint and parallel; telemetry depends on the new ordering being live so the same dispatched event carries the chosen root + per-root counts. Dispatch graph: `2.1 ∥ 2.2 → 2.3`

### Task 2.1 — Population at chain.start

```yaml meta
id: '2.1'
files:
  - packages/core/src/writers/handoff.ts
  - packages/core/test/writers/handoff.test.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: ['2.2']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

In the handoff insert path (`HandoffWriter` — `packages/core/src/writers/handoff.ts`), populate `root_handoff_id` on every new row:

- `parent_handoff_id IS NULL` → `root_handoff_id = handoff_id` (self-rooted).
- `parent_handoff_id` set → single-row read of the parent's `root_handoff_id`; persist the inherited value.
- Parent row missing (orphaned reference) → self-root + log warning. Don't fail the insert.

The lookup is one indexed read per insert; negligible at insert rate. Inheritance is denormalized at write time — the claim query stays a flat scan with no recursive CTE.

**Tests** (extend `packages/core/test/writers/handoff.test.ts`):
1. Insert with no parent → row's `root_handoff_id === handoff_id`.
2. Insert with parent → row inherits parent's `root_handoff_id`.
3. Recursive sub-dispatch: grandchild reads parent's already-populated root (no walk).
4. Orphaned `parent_handoff_id` (parent never inserted): row self-roots and a warning is emitted.
5. Multi-root sanity: two independent root chains keep distinct `root_handoff_id` values.

**Commit:** `feat(core): populate root_handoff_id on handoff insert`

### Task 2.2 — Fair-queue ORDER BY at claim listing + EXPLAIN check

```yaml meta
id: '2.2'
files:
  - packages/core/src/readers/handoff.ts
  - packages/core/test/readers/handoff.test.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: ['2.1']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Replace the FIFO `ORDER BY ts ASC` in the claim-path listing — `listByStatus({ statuses: ['approved', 'redirected'], ... })` at `packages/core/src/readers/handoff.ts:25` is the worker's polled query — with the per-root-in-flight subquery from the spec:

```sql
SELECT h.* FROM handoffs h
WHERE h.status IN (...)
  [AND h.conversation_id = ?]
ORDER BY (
  SELECT COUNT(*) FROM handoffs h2
  WHERE h2.status='dispatched' AND h2.root_handoff_id = h.root_handoff_id
) ASC,
h.ts ASC;
```

Atomic claim semantics (`HandoffWriter.claimDispatch` at `packages/core/src/writers/handoff.ts:142`) remain unchanged — the new ORDER BY decides *which* row, the existing UPDATE-and-return decides ownership. No new locking added; the existing UPDATE-with-WHERE-status-check guards the claim race between concurrent worker pollers.

If the planner won't use `idx_handoffs_root_status` for the correlated subquery on small tables, materialize the per-root counts in a CTE / window function (sqlite ≥ 3.25) — pick the form whose `EXPLAIN QUERY PLAN` shows index use; document the chosen form inline.

Scope-limit: only `listByStatus` and `listPending` paths used by claim flow change. Other readers using `ORDER BY ts ASC` (e.g. `getLatestForConversation`, dispatch-event readers) are untouched.

**Tests** (extend `packages/core/test/readers/handoff.test.ts`):
1. Two-chain interleave at the reader level: insert chain A (4 approved), chain B (1 approved arriving 50ms after A's first); call `listByStatus({ statuses: ['approved'] })`; mark A's first as `dispatched`; re-list and assert B's row is returned before A's remaining tail.
2. Single-root unchanged: 8 approved rows from one chain → returned in `ts ASC` order; no extra latency.
3. EXPLAIN QUERY PLAN test: `db.query('EXPLAIN QUERY PLAN ' + sql).all()` must mention `idx_handoffs_root_status` (string-match on the plan output).
4. Claim-race invariant: two concurrent `claimDispatch` calls on the row returned first → exactly one wins (existing test pattern; assert post-ORDER-BY change still holds).

**Commit:** `feat(core): fair-queue claim ordering by per-root in-flight count`

### Task 2.3 — Telemetry: per-root counts at claim emit

```yaml meta
id: '2.3'
files:
  - packages/daemon/src/routes/handoffs.ts
  - packages/daemon/test/routes/handoffs-claim-telemetry.test.ts
file_scope: extend-shared
depends_on: ['2.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

At the daemon claim route (`packages/daemon/src/routes/handoffs.ts:210`, where `claimDispatch` is invoked), on a successful claim emit a `dispatch_events` row carrying:

- `kind='claim'` (add to the existing kind enum if not already present; verify via grep before declaring new).
- `meta_json` contains `{ root_handoff_id, per_root_top3: [{ root_handoff_id, in_flight_count }, ...] }`.

Counts come for free from a single `SELECT root_handoff_id, COUNT(*) FROM handoffs WHERE status='dispatched' GROUP BY root_handoff_id ORDER BY count DESC LIMIT 3` at claim time — bounded by `concurrency` (worker default 8), no aggregation table.

**Tests** (new `packages/daemon/test/routes/handoffs-claim-telemetry.test.ts`):
1. Single-chain claim → event row exists; `meta_json.root_handoff_id` matches the chain's root; `per_root_top3` length 1.
2. Two-chain claim (A claimed first, B queued): claim B → event's `per_root_top3` includes both roots; A's count is 1 at the moment of B's claim.
3. Claim that loses the race → no telemetry event emitted (`claimDispatch` returned false).

**Commit:** `feat(daemon): emit per-root in-flight telemetry at claim time`

**Integration:** `bun test packages/core/test/writers/handoff packages/core/test/readers/handoff packages/daemon/test/routes/handoffs-claim-telemetry`. No daemon restart (claim path is HTTP-served code; route reload picks up on the existing daemon process if hot-reload is wired, otherwise pick up on next routine restart).

---

## Phase 3 — End-to-end interleave smoke

Daemon-level integration test exercising the spec's "smallest end-to-end smoke" scenario — two chains, claim sequence asserted on returned `handoff_id`s. Dispatch graph: `3.1`

### Task 3.1 — Two-chain interleave smoke

```yaml meta
id: '3.1'
files:
  - packages/daemon/test/sweepers/fair-claim-queue.test.ts
file_scope: new
depends_on: ['2.3']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

New daemon-level integration test using SQL setup + repeated claim-cycle calls (no real worker; use `HandoffReader.listByStatus` to pick first candidate, `HandoffWriter.claimDispatch` to take ownership, simulating the worker poll loop).

Setup:
1. Boot a real sqlite via `loadSqliteVec` + `migrate(db, { embeddingDim: 384 })` (lands at v12 with the column populated).
2. Insert chain A: root `A` + 3 children, all `status='approved'`, `ts` spaced 1ms apart starting at `t0`.
3. Insert chain B: root `B` + 0 children (1 row total), `status='approved'`, `ts = t0 + 50ms`.

Assertions:
1. **Pre-fix-equivalent FIFO would yield A.0, A.1, A.2, A.3, B.0.** Post-fix yields the spec's interleave: claim 1 → A.0 (both roots tied at 0 in-flight, FIFO breaks → A first); claim 2 → B.0 (B.in_flight=0 < A.in_flight=1); claim 3 → A.1 (B exhausted, A.in_flight drops back to 1 after A.0 still dispatched? — actually A.in_flight stays 1 until A.0 transitions; B.in_flight=1 once B.0 dispatched, so A and B both at 1, FIFO → A.1); claims 4–5 → A.2, A.3.
2. **Single-root regression check:** drop B, leave A's 4 rows. Sequential claims yield A.0, A.1, A.2, A.3 in `ts` order — no perf regression vs pre-fix.
3. **Mid-stream completion:** complete A.0 (`status='completed'`) between claims; A's in-flight drops; verify next claim still respects ordering relative to B.
4. **Telemetry assertion:** the claim of B.0 emits a `dispatch_events` row whose `meta_json.root_handoff_id === 'B'` and whose `per_root_top3` includes both roots.

**Commit:** `test(daemon): fair-claim-queue two-chain interleave smoke`

**Integration:** `bun test packages/daemon/test/sweepers/fair-claim-queue`. Then run the sweep to catch regressions: `bun test packages/core packages/daemon`. Bun ONNX teardown panic is cosmetic; judge by pass/fail counts.

---

## Acceptance criteria

Mirrors the spec's six numbered criteria; each lists a concrete verification command.

1. **Schema 12 has `root_handoff_id` populated for all rows.** `bun -e "const db = ...; console.log(db.query(\"SELECT COUNT(*) FROM handoffs WHERE root_handoff_id IS NULL\").get())"` → `{ count: 0 }`.
2. **New top-level chain self-roots.** `bun test packages/core/test/writers/handoff` Task 2.1 test 1 passes.
3. **Sub-dispatch inherits parent's root.** `bun test packages/core/test/writers/handoff` Task 2.1 test 2 passes.
4. **Multi-root smoke produces interleaved claim order.** `bun test packages/daemon/test/sweepers/fair-claim-queue` Task 3.1 test 1 passes.
5. **Single-root unchanged.** `bun test packages/daemon/test/sweepers/fair-claim-queue` Task 3.1 test 2 passes.
6. **Per-root in-flight count visible in `dispatch_events`.** `bun test packages/daemon/test/routes/handoffs-claim-telemetry` Task 2.3 tests 1–2 pass.

## Verification commands (cheat sheet)

```bash
bun typecheck
bun test packages/core/test/db/migration-11-to-12
bun test packages/core/test/writers/handoff
bun test packages/core/test/readers/handoff
bun test packages/daemon/test/routes/handoffs-claim-telemetry
bun test packages/daemon/test/sweepers/fair-claim-queue
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/2026-05-06-fair-claim-queue.md
```

## Self-review

- **Phase ordering minimizes daemon restarts.** One restart total, after Phase 1 (v11→v12). Phases 2 and 3 are pure code on top of the v12 schema; population, claim ordering, telemetry, and the interleave smoke all run against the same already-migrated db.
- **Estimated total task count.** 5 tasks across 3 phases. Spec is 141 lines; plan is proportional. Substantially smaller than cross-repo plan-runtime (21 tasks) and maestro-behavior-hooks (~6 tasks); reflects the spec's narrow scope — single column, one ORDER BY, one telemetry line.
- **Partition rationale.** The spec lists 5 substrate pieces (schema, population, backfill, claim ordering, telemetry). Schema + backfill collapse into one atomic migration (1.1) — separating them risks an intermediate state where the column exists but isn't populated. Population (writer-side) and claim ordering (reader-side) are file-disjoint and parallelize cleanly (2.1 ∥ 2.2). Telemetry (2.3) is a single emit at the daemon claim route; depends on 2.2 only because the per-root counts are most meaningful when fair-ordering is live. Smoke test (3.1) is a single integration test — splitting it gains nothing.
- **Known risks specific to claim-path changes:**
  1. **Claim races between concurrent worker pollers.** The new ORDER BY changes *which* row the listing returns first; the per-row claim is still atomic via `UPDATE handoffs SET status='dispatched' WHERE handoff_id=? AND status IN (...)`. No additional locking is added. Worker concurrency=8 means up to 8 pollers may race; the existing UPDATE-with-WHERE-status-check resolves the race; only one wins. Documented inline at the new ORDER BY.
  2. **Query plan regression on single-chain workloads.** EXPLAIN QUERY PLAN is asserted in 2.2 test 3 to confirm `idx_handoffs_root_status` use. If the planner ignores the index for the correlated subquery on small tables, the fallback is a CTE / window-function form (sqlite ≥ 3.25) with the same semantics — pick whichever EXPLAIN approves. Single-root regression is guarded by 3.1 test 2.
  3. **Backfill perf on large tables.** V1 dev DB is sub-10k rows; backfill walks parent chains in batched UPDATE per visit-tier with depth cap 16. Estimated cost: O(rows × avg_depth), with avg_depth ≪ 16 in practice (sub-dispatch chains observed at depth ≤ 3). On a 10k-row table this completes in low-hundreds of ms inside the migration tx. Future growth fallback (deferred): move to background sweeper that runs after daemon serves, with the claim query treating NULL roots as effectively self-rooted for the duration. Self-root + warning fallback covers both the depth-cap overflow and orphaned-parent cases (1.1 tests 3–4) so the migration never fails closed.
- **Backwards compat.** Pre-v12 db's get the column added in-place (`ALTER TABLE`) plus a one-shot in-tx backfill — no row rewrite beyond the backfill UPDATE. Post-migration writers always set `root_handoff_id` on insert. Readers outside the claim path are untouched.
- **Reconciler.** Unblocked as of `002571e`; auto-FF expected. Manual cherry-pick from `agent/<id>` worktrees is the fallback if a phase races a maestro commit. Phase 1 is the only restart point; if a maestro commit lands during Phase 2 dispatch, the v12 column is already live so no schema race exists.
