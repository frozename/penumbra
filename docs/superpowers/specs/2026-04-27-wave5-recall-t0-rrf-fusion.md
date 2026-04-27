# Wave 5 Recall: t0 Retrieval & RRF Fusion Implementation Spec

**Date:** 2026-04-27
**Scope:** Implementation of t0 retrieval branch, Reciprocal Rank Fusion (RRF) engine, and recall integration.
**Predecessor:** [Wave 5 Recall Recon: Multi-Tier Memory Fusion](../plans/2026-04-27-wave5-recall-recon.md)

---

## Goal

Wave 5 completes the multi-tier recall surface by adding a t0 query branch (the only unimplemented tier in the existing recall surface) and replacing the current flat global-score sort with Reciprocal Rank Fusion (RRF) across all three tiers (t0, t1, t2). This ensures that fresh, raw events can be surfaced alongside processed summaries and durable memories without score-scale biases.

## Wave Breakdown (Commit Sequence)

### Commit 1: t0 query branch
Add `queryT0(query: string, ...)` to `packages/core/src/readers/recall.ts`. Since t0 has no embeddings (no `t0_vec` virtual table per `packages/core/src/db/schema.ts`), use FTS5 over `t0_events.payload_json` text content.
- **Implementation**: Create or use an existing FTS5 virtual table for `t0_events.payload_json`. Execute a MATCH query and map results to the `RecallResult` schema.
- **Acceptance Criteria**: A recall call with `include_raw=true` against a corpus that has only t0 rows returns t0 hits with non-empty `body`.
- **Testing**: Add unit tests in `packages/core/test/readers/recall.test.ts`.

### Commit 2: RRF fusion engine
Add `fuseRRF(perTierHits: { [tier in 't0' | 't1' | 't2']?: RecallResult[] }, k?: number = 60): RecallResult[]` as a pure helper in `packages/core/src/readers/recall.ts` (or a sibling module).
- **Implementation**: Each tier's input list MUST already be sorted by intra-tier rank (best-first; the natural output order of each query branch). For each list, compute `1 / (k + rank)` per item where `rank` is 1-indexed. Sum the RRF scores per item (deduplicated by `id`). Sort by combined RRF score descending. Default `k=60` per the original RRF paper.
- **Acceptance Criteria**: Unit tests cover empty inputs, single-tier inputs, and a fused 3-way example with hand-computed expected order.
- **Testing**: Create `packages/core/test/readers/rrf.test.ts` or add to existing recall tests.

### Commit 3: Integrate fusion into recall
Replace the flat global score-sort in `RecallReader.recall()` with the `fuseRRF` engine.
- **Implementation**: Fetch results from t0 (if requested), t1, and t2. Pass the three lists into `fuseRRF` and return the top-N results.
- **Acceptance Criteria**: Existing recall tests still pass; a new test asserts that a heavily-ranked t2 result no longer eclipses a moderately-ranked t1 result (proving rank-based fusion vs. score-based sort).
- **Testing**: Update `packages/core/test/readers/recall.test.ts`.

### Commit 4: Caller surface
Verify and update the CLI and MCP surfaces to ensure they correctly accept and forward the `include_raw` parameter.
- **Implementation**: Audit `packages/cli/src/commands/recall.ts` and `packages/mcp/src/tools/recall.ts`. Ensure flags are correctly mapped to the core `RecallReader` options.
- **Acceptance Criteria**: Integration test exercising `penumbra recall <q> --include-raw` returns mixed-tier results.
- **Testing**: Manual verification and integration tests in `packages/agentchat/test/integration/`.

## Risk Register

- **Implementation Disconnect**: t0 is declared in the schema/enums but currently unimplemented in the retrieval logic. This spec explicitly addresses this by adding the FTS5 branch.
- **Backward Compatibility**: Changing the ordering algorithm from score-based to rank-based (RRF) will change recall responses for existing callers. This is acceptable as consumers should already depend on the `tier` discriminator for context, rather than the absolute score value.
- **Performance**: Performing FTS5 searches alongside vector searches adds latency. The implementation must ensure these queries run efficiently, possibly in parallel.
- **Embedding Dim**: Not applicable for t0 as it uses text search; no risk of dimension mismatch.

## Schema Impact

**None.**
The implementation will utilize the existing `t0_events` table. If an FTS5 virtual table is not already present for `t0_events.payload_json`, it will be added as part of Commit 1's setup. No destructive migrations are required.

## Out of Scope (Defer to Wave 6+)

- **Per-project recall scoping**: Currently handled at a higher level or deferred.
- **Metadata filters on t2 hits**: Filtering by `kind` or `source_session_ids`.
- **Query expansion / synonym handling**: Advanced NLP techniques to improve recall breadth.
- **Cross-tier deduplication**: Handling cases where a t1 summary and a t2 memory cover identical information.
