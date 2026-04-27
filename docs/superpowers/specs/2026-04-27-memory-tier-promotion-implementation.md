# Memory Tier Promotion Implementation (t1 → t2)

**Date:** 2026-04-27
**Scope:** Implementation of t1→t2 promotion worker, t2 promotion criteria, t0 retention policy, and recall integration.
**Predecessor:** [Memory Tier Promotion Lifecycle Audit + Design](./2026-04-27-memory-tier-promotion-design.md)

---

## Problem

The previous audit identified that while Penumbra ships with three storage tiers (`t0`, `t1`, `t2`), the promotion lifecycle from `t1` (session rollups) to `t2` (long-term semantic memories) is entirely absent. Specifically:
1. **No `t1 -> t2` Path:** Every `t1` row is currently an orphan. The `t2_memories` table exists but has no producer.
2. **Unbounded `t0` Growth:** A retention policy (`t0RetentionDays`) is declared but not implemented, meaning raw events grow indefinitely.
3. **Recall Incompleteness:** The recall API blends `t1` and `t2`, but since `t2` is never populated, recall only ever surfaces `t1` session summaries.

We need to implement the actual worker and criteria to promote mature `t1` session summaries into durable `t2` memories, prune old `t0` data to maintain performance and privacy, and ensure these new `t2` memories are actively surfaced in existing recall queries.

## Approach

To establish a durable and observable memory lifecycle, we will introduce a dedicated `t2` promotion worker and a `t0` retention worker.

### T2 Promotion Criteria
Promotion from `t1` to `t2` should not be 1:1. A session rollup (`t1`) becomes a candidate for `t2` promotion based on:
1. **Age / Cool-down:** The `t1` rollup must be at least 24 hours old to ensure the session is truly cold and no late-arriving events will trigger a re-roll.
2. **Semantic Salience:** We will use an LLM-based summarization pass (via Sirius) to extract standalone "facts", "decisions", or "patterns" from the `t1` excerpt. If the LLM determines the session contains no long-term value, it is marked as reviewed but not promoted.
3. **Deduplication:** The promotion worker will query existing `t2_vec` to ensure the newly extracted memory isn't highly redundant (e.g., >0.95 cosine similarity with an existing `t2` row).

### T0 Retention Policy
Raw `t0` events are the source of truth but are expensive to keep forever.
- **Rule:** A `t0` event is eligible for deletion if it is older than `t0RetentionDays` (default: 30 days) AND it has been successfully rolled up into a `t1` row.
- **Session-less Events:** Events with `session_id = null` will be deleted strictly based on `t0RetentionDays` age, as they have no `t1` promotion path.

### Recall Integration
The `RecallReader` already queries `t1_vec` and `t2_vec`. We will update the scoring weights to slightly favor `t2` memories over `t1` rollups when both match a query strongly, as `t2` represents synthesized, durable knowledge.

## Components and per-package changes

### `packages/core/src`
- **`db/schema.ts`**: Add `t2_promoted_at` to `t1_rollups` to track which sessions have been evaluated for promotion (prevents infinite re-evaluation).
- **`writers/t2.ts` (NEW)**: Implement `T2Writer` with methods `promoteFromT1(t1Row)` and `writeMemory(payload)`.
- **`readers/recall.ts`**: Adjust the merge logic between `t1` and `t2` hits to apply a slight multiplier (e.g., 1.1x) to `t2` scores.
- **`settings.ts`**: Validate `t0RetentionDays` and add `t2PromotionDelayHours` (default: 24).

### `packages/daemon/src`
- **`workers/t2-promotion.ts` (NEW)**: Analogous to `t1-rollup.ts`. Runs periodically (e.g., every 6 hours). Scans `t1_rollups` where `t2_promoted_at` is null and `ended_at` is older than the cool-down period. Invokes the LLM to extract memories and writes to `t2`.
- **`workers/t0-retention.ts` (NEW)**: Runs daily. Deletes `t0_events` older than `t0RetentionDays` that are covered by a `t1_rollup` or have no `session_id`.
- **`serve.ts`**: Register and start both `createT2PromotionWorker()` and `createT0RetentionWorker()`.

## Data flow

```text
raw event arrives
  |
  v
[t0_events] ---(idle timeout / session.end)---> [t1-rollup worker]
  |                                                |
  |                                                v
  |                                          [t1_rollups]
  |                                                |
(t0-retention worker)                        (t2-promotion worker: runs every 6h)
  |                                                |--- wait 24h cool-down
  |--- deletes if > t0RetentionDays                |--- LLM extraction / dedupe
  |    AND covered by t1 (or null session)         v
  v                                          [t2_memories] & [t2_vec]
[t0_events] (pruned)                               |
                                                   v
                                             [Recall API] <--- queries both t1 & t2
```

## Test plan

- **T2 Promotion Worker:** Unit tests mocking the LLM extraction to return 0, 1, or multiple facts. Verify that `t1_rollups.t2_promoted_at` is always updated regardless of whether a `t2` row is created, preventing stuck candidate loops.
- **T0 Retention:** Integration tests inserting `t0` rows with simulated old timestamps. Verify that rows covered by `t1` are deleted, rows without `t1` coverage are kept (unless session-less), and `t0RetentionDays` boundaries are strictly respected.
- **Recall Integration:** Insert identical concepts into `t1` and `t2`. Query the concept and assert that the `t2` hit ranks higher due to the new weighting multiplier.
- **Migration:** Apply the `t2_promoted_at` column migration and verify that existing `t1` rows default to null, making them eligible for immediate `t2` evaluation.

## Migration safety

- **DB Schema:** Adding `t2_promoted_at` (timestamp, nullable) to `t1_rollups` is a non-destructive, backward-compatible schema change.
- **Idempotency:** The promotion worker will mark `t2_promoted_at` in the same transaction as inserting the `t2_memories` rows, ensuring safe recovery if the daemon restarts mid-promotion.

## Out of scope

- Updating the Context File (`latest.md`) format. It already reads `t2` if rows exist; we will rely on the existing rendering for now.
- `t1` compaction or deletion. For this phase, `t1` rows remain indefinitely as the intermediate session-level index.
- Operator CLI commands for forcing `t2` promotion. We will rely on the daemon worker for the initial implementation.

## Open questions

1. **LLM Cost for Promotion:** Running an LLM extraction pass over every `t1` rollup could be expensive. Should we introduce a heuristic (e.g., `t1` must have > N events or specific tool usage) to qualify for LLM evaluation?
2. **Update vs. Append:** If a user manually re-rolls a session (`t1` is updated), do we invalidate the previously extracted `t2` memories, or append new ones? (Current leaning: append, but rely on deduplication).
3. **Session-less T2 Candidates:** Can session-less `t0` events (e.g., CLI ad-hoc commands) ever become `t2` memories, or are they strictly audit logs destined for deletion?
