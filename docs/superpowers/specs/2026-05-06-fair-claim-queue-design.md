# Per-Chain-Root Fair Claim Queue — Design Spec

**Status:** Draft 2026-05-06 · **Scope:** Worker dispatch-claim ordering becomes fair across chain roots. Replaces FIFO claim with weighted fair queueing keyed on chain root. Closes the multi-session bottleneck where one session's chains starve another's. · **Depends on:** existing handoff table + claim-dispatch path (shipped in agentchat V1).

## Goal

With N concurrent chains across M user-initiated roots, no single root holds more than its fair share of the worker's `concurrency` slots when other roots have queued work. "Fair share" is a soft preference, not a hard cap: when only one root has queued work, it gets all `concurrency` slots; when multiple roots compete, claim order interleaves across them so a small root doesn't sit behind a large root's tail.

The motivating bug: maestro running this design hit `status=approved` waits of 5+ minutes while a parallel Claude Code session's chains saturated the worker. Bumping `concurrency=4 → 8` (commit `cb7d0f6`) raises the ceiling but doesn't change the FIFO race; N sessions × M dispatches each still queue head-of-line.

## Architecture choice: weighted fair queueing on chain root

Considered and rejected:

- **MCP caller `cwd` keying.** Cheapest. But conflates two roots running in the same cwd (e.g. two `/handoff` slash commands fired in succession from the same Claude Code session — they should still balance against each other if they overlap). Right answer for "two repos," wrong answer for "two intents in one repo."
- **Claude Code session_id keying.** More correct than cwd, but a single session can spawn many parallel chains (e.g. `/handoff` then immediately `/brainstorm`); both should be fair against each other within that one session.
- **Strict cap per root** (`concurrency / N_active_roots`). Rejected: tick-time rebalancing complexity; underutilizes when one root has bursty work; existing claim path is pull-based (worker asks for next), not push-allocated.
- **Pure round-robin claim.** Simpler than weighted but doesn't gracefully degrade — when one root has 1 queued and another has 50, RR adds latency to the small root.
- **Weighted fair queueing on chain root (chosen).** Each handoff carries a `root_handoff_id`. Claim path orders by `(in-flight count for this root) ASC, ts ASC`. Natural soft preference: a root with 0 in-flight beats a root with 3, but FIFO tiebreak preserves age fairness within roots. No per-tick scheduler. Single SQL change at the claim path. Backwards-compatible after a one-time backfill.

## V1 substrate

Five pieces, in dep order.

### 1. Schema bump v11 → v12

`handoffs` gains `root_handoff_id TEXT`. New index `(status, root_handoff_id)` to keep the per-root in-flight count fast under the claim query. Migration is in-place; no row rewrite beyond the backfill below.

The column is nullable on the schema but populated for every row by the time the migration commits — the not-null contract is enforced by the population logic rather than by `NOT NULL`, which would break the in-place migration on existing rows. Post-migration writers always set the column on insert.

**Integration point.** `packages/core/src/db/schema.ts` (migration v11→v12). `SCHEMA_VERSION` bump. Mirrors the v9 / v10 / v11 migration test pattern (idempotent migration test alongside the schema change).

### 2. Root population at chain.start

When a new handoff is created:

- If `parent_handoff_id` is null → `root_handoff_id = handoff_id` (self-rooted).
- If `parent_handoff_id` is set → look up the parent's `root_handoff_id` (single-row read, denormalized).
- Persist on insert.

**Why this shape.** Denormalize at insert so the claim query stays a flat scan — no recursive CTE per claim, no walk through parent chains at hot-path time.

**Integration point.** Wherever handoffs are inserted on `chain.start` (current `handoff` writer in `packages/core/src/handoffs/`).

### 3. Backfill for existing rows

At daemon boot inside the v11→v12 migration: backfill `root_handoff_id` for any rows where it is NULL. Walk `parent_handoff_id` chains; rows with no parent become their own root. One-shot, idempotent, runs in the same transaction as the schema migration. Cap walk depth at 16 — any deeper is a chain bug; mark `root = self` and emit a warning to the migration log.

**Integration point.** Same migration step as the schema change. Done inside the migration helper rather than a separate sweeper so the column is never observed NULL post-migration.

### 4. Fair-queue claim ordering

Modify the claim path's "next available handoff" query (currently `WHERE status='approved' ORDER BY ts ASC LIMIT 1`) to:

```sql
SELECT h.* FROM handoffs h
WHERE h.status='approved'
ORDER BY (
  SELECT COUNT(*) FROM handoffs h2
  WHERE h2.status='dispatched' AND h2.root_handoff_id = h.root_handoff_id
) ASC,
h.ts ASC
LIMIT 1;
```

Single change at the daemon's claim route. No worker-side change. Atomic claim semantics (existing `claimDispatch`) remain unchanged — the new ORDER BY decides which row, the existing UPDATE-and-return decides ownership.

**Integration point.** Daemon claim route (the SQL behind `claimDispatch`). Verify with `EXPLAIN QUERY PLAN` that the new index is used.

### 5. Telemetry

Log per-root in-flight count + per-root claim count at claim time. Surface via the existing `dispatch_events` `kind='claim'` (or add a new kind if claim isn't already in the enum). Counts come for free from the SQL above — keep it cheap.

**Integration point.** Same daemon claim route as (4). One additional event emit per claim. Counts are bounded by `concurrency` and update at claim cadence; no aggregation table, no separate sweeper.

A second log line at claim time records the chosen `root_handoff_id` and the per-root counts of the top three roots in the queue. This makes "did fair queueing actually fire?" diagnosable from `dispatch_events` alone, without correlating across rows.

## Edge cases in root semantics

- **Top-level chain (no parent).** Self-rooted: `root_handoff_id = handoff_id`. The chain competes against itself with `in_flight ≥ 1` once any sub-dispatch begins, but since other roots are evaluated against the same metric, the math stays consistent.
- **Sub-dispatch from a maestro.** Inherits parent's root. A maestro fanning out 5 sub-dispatches under one parent counts as 5 in-flight against the same root — exactly what we want; that maestro's burst should not crowd out an unrelated chain.
- **Recursive sub-dispatch.** Grandchild reads parent's `root_handoff_id`, which is already populated (parent inherited from its own parent). No recursion at insert time.
- **Orphaned parent_handoff_id.** Parent referenced but row missing (data corruption). Treat as self-rooted, log a warning. Don't fail the insert — the chain itself is independent of the lookup result.
- **Root status terminal but children pending.** If the root completes/fails while children are still queued, `root_handoff_id` stays valid as a grouping key; status of the root row doesn't influence the in-flight count (which only counts `status='dispatched'` regardless of which row in the group).

## The smallest end-to-end smoke

Two chains with overlapping handoffs, hand-crafted via direct DB inserts:

1. Chain A (root `A`): 4 handoffs queued back-to-back, `status=approved`.
2. Chain B (root `B`): 1 handoff queued ~50ms after A's first, `status=approved`.

Pre-fix: worker claims A.1, A.2, A.3, A.4, then B.1 last → B waits behind all of A.

Post-fix: worker claims A.1 (A.in_flight=0, B.in_flight=0, FIFO wins → A first), then B.1 (B.in_flight=0 < A.in_flight=1), then A.2, A.3, A.4. B's first dispatch lands within ~1 claim cycle of approval.

Smoke test exercises this exact pattern via SQL setup + repeated `nextClaim()` calls, asserting on the returned `handoff_id` sequence.

**Integration point.** New test in `packages/daemon/test/` or `packages/core/test/` — alongside the existing claim-path tests.

## Acceptance criteria

1. Schema 12 has `handoffs.root_handoff_id` populated for all rows after migration; no NULLs remain.
2. New `chain.start` (no parent) sets `root_handoff_id = handoff_id`.
3. Sub-dispatch `chain.start` (with `parent_handoff_id`) inherits the parent's `root_handoff_id`.
4. Multi-root smoke (2 chains, 5 handoffs total) produces interleaved claim order, not FIFO-by-chain.
5. Single-root case unchanged: 8 handoffs from one chain → worker claims them FIFO until concurrency saturates, no extra latency vs pre-fix.
6. Per-root in-flight count visible in `dispatch_events` for at least the claim event.

## Risks

- **Backfill performance** on a large `handoffs` table. V1 dev DB is sub-10k rows; future growth may matter. Mitigation: walk parent chains in batched UPDATE; cap depth at 16; do it once inside the migration tx. If walk time becomes user-noticeable on daemon boot, move backfill to a background sweeper that runs after the daemon is serving (the claim query still works on rows that have a root, ignoring NULL roots as effectively self-rooted for the duration).
- **Claim query plan.** The correlated subquery may not use the new index efficiently on small tables; verify with `EXPLAIN QUERY PLAN`. If the planner picks a scan, materialize the per-root count in a CTE or use a window function (sqlite ≥ 3.25 supports them).
- **Claim races between worker pollers.** Worker has `concurrency=8`; multiple internal pollers may race the claim. Existing `claimDispatch` already handles this atomically via UPDATE-with-WHERE-status-check; verify the invariant still holds after the ORDER BY change.
- **Inheritance lookup cost.** Parent lookup at `chain.start` time is one row read. Negligible at insert rate.
- **Root-id leak across user contexts.** Two different Claude Code sessions accidentally sharing a `parent_handoff_id` (shouldn't happen, but flag as invariant). V1 logs a warning if `chain.start` references a `parent_handoff_id` whose originating client differs from the new chain's.

## Open questions

- Realistic max depth in current `parent_handoff_id` chains — if observed >16, raise the cap before shipping.
- Should claim ORDER also incorporate dispatch-end-time, so a root that just released a slot doesn't immediately re-claim if another root is waiting? V1 says no — keep the rule simple, in-flight count is enough. V2 may add anti-thrash hysteresis.
- Per-root concurrency cap (hard limit) deferred to V2 — soft preference should suffice; revisit if data shows runaway roots.
- Telemetry surface — `dispatch_events` row vs. a per-root MCP query (`chain.fairness.snapshot`) for live debugging? V1 ships `dispatch_events` only.

## Deliberately deferred

- **Per-root cost / token budgets.** Sibling to `bounds` on orchestrate tasks but at root scope. Useful for cost-cap-per-intent but not required for fairness.
- **Cross-machine worker pool.** V1 is single-daemon; multi-daemon fairness is a separate spec.
- **Hot-reload of fairness config** (e.g. switch from per-root to per-cwd at runtime). V1 picks one keying choice.
- **Preemption** (kill in-flight low-priority dispatches for higher-priority arrivals). V1 is preemption-free.
- **Anti-thrash hysteresis.** A root that just freed a slot competes equally on the next tick; V2 may add a small re-claim penalty.

## Smallest implementation slice (phase order hint)

1. Schema + backfill migration (atomic).
2. Root population on `chain.start`.
3. Claim ORDER BY change.
4. Smoke test for the two-chain interleave.
5. Telemetry log line at claim.

No new MCP surface, no new tables, no worker-side wiring, no plist change.
