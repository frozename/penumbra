# Phase 3 Wave 1 Recon — Memory Tier Promotion

**Date:** 2026-04-27
**Status:** Complete
**Reference Spec:** [2026-04-27-memory-tier-promotion-implementation.md](../specs/2026-04-27-memory-tier-promotion-implementation.md)
**Reference Plan:** [2026-04-27-memory-tier-promotion-implementation.md](./2026-04-27-memory-tier-promotion-implementation.md)

---

## 1. Current t1-rollup worker
The `t1-rollup` worker is the primary mechanism for session-level memory aggregation.

- **Lifecycle & Entry Point:** `packages/daemon/src/workers/t1-rollup.ts` defines `createRollupWorker` (L11). It is a functional worker intended to be driven by a `Supervisor` or periodic `setInterval`.
- **Trigger Conditions:** `detectIdleSessions` (L111 in `packages/core/src/writers/t1.ts`) identifies sessions where `MAX(t0_events.ts)` is older than `idleMinutes` and no corresponding `t1_rollups` row exists.
- **Production Output:** 
    - `t1_rollups` row containing metadata, costs, and prompt/response excerpts (L89 in `packages/core/src/writers/t1.ts`).
    - `t1_vec` row (L101 in `packages/core/src/writers/t1.ts`) storing embeddings of concatenated excerpts.
- **Context Integration:** The worker explicitly triggers `ContextFileWriter.rewrite(projectId)` (L37 in `t1-rollup.ts`) upon successful session rollup.

## 2. Current t2 surface
The long-term storage tier (`t2`) is structurally defined but functionally inert.

- **Schema State:** `packages/core/src/db/schema.ts` contains `t2_memories` (L74) and `t2_vec` (L134). The schema is already more sophisticated than the "fact extraction" spec, including fields like `kind`, `window_start`, `window_end`, and `compressed_from`.
- **Promotion Paths:** **NONE.** There are no writers for `t2` currently implemented in `packages/core/src/writers/`.
- **Recall Behavior:** `RecallReader.recall` (L19 in `packages/core/src/readers/recall.ts`) already performs a parallel search across `t1_vec` and `t2_vec`. It merges and re-sorts results based on raw distance-to-score conversion (L104).

## 3. ContextFileWriter integration
The `ContextFileWriter` is the consumer of both `t1` and `t2` data for generating `latest.md`.

- **Consumption Logic:** `rewrite(projectId)` (L29 in `packages/core/src/context-file/writer.ts`) queries both `t1_rollups` and `t2_memories` up to `topK`.
- **Integration Gaps:** Currently renders a "no memories yet" message if both are empty. Since `t2` is never written to, the "Cross-session memories" section (L69) is effectively dead code in the current build.

## 4. Schema Gaps
To implement Wave 2, the following additions are required:

- **`t1_rollups` Table:** Needs `t2_promoted_at` (TEXT, nullable) to prevent re-evaluation loops.
- **`applySchema`:** Needs a helper to add this column to existing databases (L139 in `packages/core/src/db/schema.ts`).
- **`SettingsSchema`:** `t0RetentionDays` default is 14 (L4 in `packages/core/src/settings.ts`); spec wants 30. `t2PromotionDelayHours` is missing and must be added.

## 5. Top 3 Surprises

1. **Tight Coupling:** The `t1-rollup` worker is directly responsible for triggering the `ContextFileWriter`. This suggests the `t2-promotion` worker should follow suit to ensure `latest.md` reflects promoted memories immediately.
2. **Advanced T2 Schema:** The existing `t2_memories` schema (likely from an earlier draft) implies a temporal windowing strategy (`window_start`/`end`) and a hierarchy (`compressed_from`), which is more complex than the single-session promotion proposed in the current spec.
3. **Ghost Settings:** `t0RetentionDays` already exists in `SettingsSchema` but is not utilized by any worker or deletion logic in the current codebase.
