# Phase 3 #1: Memory Tier Promotion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-27-memory-tier-promotion-implementation.md`

**Goal:** Establish a durable memory lifecycle by promoting mature `t1` session summaries into `t2` long-term memories via LLM extraction, and pruning expired `t0` events to manage storage growth.

**Architecture:** A dedicated `t2` promotion worker periodically evaluates "cold" `t1` rollups for semantic salience, while a `t0` retention worker prunes raw events older than a configurable threshold that have already been rolled up.

**Tech Stack:** Bun 1.3, TypeScript, bun:sqlite, zod, Sirius (for LLM extraction).

**Constraints:**
- No backward-compatibility hacks for unused code; delete if unused.
- Conventional commits with no AI/agent attribution.
- TDD discipline: failing test -> implementation -> green.
- One test per assertion concept.

---

## Execution waves

| Wave | Tasks | Description |
|---|---|---|
| **1: Recon** | T1 | Audit current `t1` and `t2` schema, existing `t1-rollup` worker shape, and `RecallReader` merge logic. |
| **2: Schema & Primitives** | T2, T3 | Add promotion tracking to `t1_rollups`, update settings, and implement the `T2Writer`. |
| **3: T2 Promotion** | T4, T5 | Implement the `t2-promotion` worker with LLM extraction, deduplication, and transaction safety. |
| **4: T0 Retention** | T6 | Implement the `t0-retention` worker with safe pruning logic. |
| **5: Integration** | T7 | Update `RecallReader` weighting and wire workers into the daemon. |

---

## Wave 1: Recon

### Task 1 — Audit current memory state
**Depends:** —

**Files:** (Read only)
- `packages/core/src/db/schema.ts`
- `packages/core/src/readers/recall.ts`
- `packages/daemon/src/workers/t1-rollup.ts`

#### Steps
- [x] Confirm `t2_memories` and `t2_vec` structure in `schema.ts`.
- [x] Review how `RecallReader` currently combines `t1` and `t2` results.
- [x] Examine `t1-rollup.ts` to identify the pattern for long-running periodic workers.
- [x] **Nit fix:** Ensure `addColumnIfMissing` helper (or equivalent) is available for `t1_rollups` migration.
- [x] Commit: `docs(plans): phase 3 wave 1 recon — t1 rollup + t2 surface + context-file state`

---

## Wave 2: Schema & Primitives

### Task 2 — Schema additions & Settings
**Depends:** T1

**Files:**
- `packages/core/src/db/schema.ts`
- `packages/core/src/settings.ts`

#### Steps
- [ ] Add `t2_promoted_at` (TEXT/nullable) to the `t1_rollups` table.
- [ ] Implement `addColumnIfMissing` logic for `t1_rollups` in `applySchema`.
- [ ] Update `SettingsSchema` in `settings.ts`:
  - [ ] Set `t0RetentionDays` default to 30 (per spec).
  - [ ] Add `t2PromotionDelayHours` (default: 24).
- [ ] Write schema tests verifying the new column and default settings.
- [ ] Commit: `feat(core): add t2_promoted_at to t1_rollups and update retention settings`

### Task 3 — `T2Writer` Implementation
**Depends:** T1

**Files:**
- `packages/core/src/writers/t2.ts` (new)
- `packages/core/src/index.ts`
- `packages/core/test/writers/t2.test.ts` (new)

#### Steps
- [ ] Implement `T2Writer` class with `writeMemory(memory: T2MemoryInput)` method.
- [ ] Ensure `writeMemory` handles both `t2_memories` (SQLite) and `t2_vec` (vector) inserts in a single transaction.
- [ ] Export `T2Writer` from `@penumbra/core`.
- [ ] Write unit tests for `T2Writer` using a mock DB.
- [ ] Commit: `feat(core): implement T2Writer for durable memory persistence`

---

## Wave 3: T2 Promotion

### Task 4 — T2 Promotion Logic (Core)
**Depends:** T2, T3

**Files:**
- `packages/core/src/services/t2-promoter.ts` (new)
- `packages/core/test/services/t2-promoter.test.ts` (new)

#### Steps
- [ ] Implement the core promotion logic:
  - [ ] Query `t1_rollups` where `t2_promoted_at` is NULL and `ended_at` is older than `t2PromotionDelayHours`.
  - [ ] **Implementer Decision Point:** Define a "Semantic Salience" prompt for Sirius to extract facts/decisions from `t1` excerpts.
  - [ ] Implement deduplication: Query `t2_vec` for similar memories before writing.
- [ ] Write tests with mocked LLM responses (0, 1, or multiple facts extracted).
- [ ] Commit: `feat(core): implement T2 promotion service with LLM extraction and dedupe`

### Task 5 — T2 Promotion Worker (Daemon)
**Depends:** T4

**Files:**
- `packages/daemon/src/workers/t2-promotion.ts` (new)
- `packages/daemon/src/serve.ts`

#### Steps
- [ ] Create `createT2PromotionWorker()` using the `Supervisor` pattern.
- [ ] Configure it to run periodically (e.g., every 6 hours).
- [ ] Ensure `t1_rollups.t2_promoted_at` is updated even if no memories are extracted (to prevent re-evaluation loops).
- [ ] Wire the worker into `serve.ts`.
- [ ] Commit: `feat(daemon): add T2 promotion background worker`

---

## Wave 4: T0 Retention

### Task 6 — T0 Retention Worker
**Depends:** T2

**Files:**
- `packages/daemon/src/workers/t0-retention.ts` (new)
- `packages/daemon/src/serve.ts`
- `packages/daemon/test/workers/t0-retention.test.ts` (new)

#### Steps
- [ ] Implement `createT0RetentionWorker()`:
  - [ ] Delete `t0_events` where `ts` < `now - t0RetentionDays`.
  - [ ] **Safety check:** Verify events are covered by a `t1_rollup` (via `session_id`) OR have `session_id = null`.
- [ ] **Implementer Decision Point:** Decide if session-less `t0` events should be evaluated for `t2` before deletion, or strictly pruned.
- [ ] Write integration tests inserting old `t0` rows with varying `session_id` coverage and verify deletion.
- [ ] Commit: `feat(daemon): add T0 retention worker with safe pruning logic`

---

## Wave 5: Integration

### Task 7 — Recall Weighting & Final Wire-up
**Depends:** T5, T6

**Files:**
- `packages/core/src/readers/recall.ts`
- `packages/core/test/readers/recall.test.ts`

#### Steps
- [ ] Update `RecallReader` to apply a 1.1x multiplier to `t2` memory scores during the merge/rank phase.
- [ ] Add a `t2_boost` parameter to the recall query schema for operator tuning.
- [ ] Verify both `t1` and `t2` hits are returned and ranked correctly in `recall.test.ts`.
- [ ] Perform a final smoke test of the entire daemon with both new workers enabled.
- [ ] Commit: `feat(core): boost T2 memories in recall and finalize integration`

---

## Implementer Decision Points

1. **LLM Cost Heuristics:** To avoid expensive extraction for trivial sessions, consider a filter (e.g., `n_events > 5` or `cost_usd_total > 0.01`) before calling the LLM.
2. **Update vs Append:** If a session is re-rolled, the plan currently favors appending new memories and relying on deduplication. Verify this is acceptable for the target UX.
3. **Session-less T2 Candidates:** The spec marks these for strict deletion. Re-confirm if any high-value ad-hoc commands should be promoted to `t2` before pruning.
