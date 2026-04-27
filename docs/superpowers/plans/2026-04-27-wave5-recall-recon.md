# Wave 5 Recall Recon: Multi-Tier Memory Fusion

> Source: gemini-pro-direct (handoff 935a8374, conv-83083ae5), 2026-04-27.
> **Caveat**: Sections (A)-(E) re-traced against actual code on 2026-04-27 by gemini-flash CLI agent. The original draft assumed recall returned only t1; in fact, the current RecallReader implementation already queries both t1 and t2. However, t0 remains unimplemented in the code despite being declared in the schema, and Wave 5 is focused on adding t0 support and implementing RRF-based fusion.

## (A) Current Recall Path Trace (t1_rollups)
The current t1 recall path executes a vector search over session summaries.

- **Execution Function**: The primary recall logic resides in `packages/core/src/readers/recall.ts:21` (inside the `recall` method of the `RecallReader` class).
- **Callers**:
  - **CLI**: Invoked via `packages/cli/src/commands/recall.ts:22` (`runRecall()`), which is wired to `penumbra recall <query>` in `packages/cli/bin/penumbra.ts:126`.
  - **MCP**: Registered as the `memory.recall` tool in `packages/mcp/src/server.ts:20` and handled by `recallHandler` at `packages/mcp/src/tools/recall.ts:18`.
  - **Daemon Route**: Served at `POST /recall` via `packages/daemon/src/routes/recall.ts:4` and `packages/daemon/src/serve.ts:51`.
  - *(Note: Agentchat does not currently invoke recall queries).*
- **Return Shape**: The function returns `Promise<RecallResult[]>`, where `RecallResult` is defined in `packages/core/src/schemas/recall.ts:25`.
  - Columns extracted: `id`, `tier` (`'t0' | 't1' | 't2'`), `score`, `title`, `body`, `project_id`, `source_session_ids`, `created_at`.
  - Score field: `score` (computed as `1 - distance / 2`).
  - Sort order: Ordered natively by `distance ASC` in `sqlite-vec`, mapped to `score` and sorted globally by `score DESC` before being sliced to `req.limit`.
- **Embedder Sharing**: The embedder instance is injected into `RecallReader` via `opts.embedder` during service construction in `packages/core/src/services.ts:87`. This guarantees the same embedder instance is shared consistently across the application.

## (B) t2 Schema Reference (already implemented)
t2 recall is already implemented in `RecallReader.recall()` today. This section captures the schema details for cross-reference during Wave 5; the SQL example below documents the existing query shape, not new code to write.

- **Schema Confirmation**: Per `packages/core/src/db/schema.ts`, `t2_memories` does NOT have an `embedding` or `embedding_dim` column directly. Crucially, `sqlite-vec` requires virtual tables for KNN queries. A sidecar virtual table `t2_vec` is defined (`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${dim}])`), which maps to `t2_memories.rowid`.
- **SQL Search**: The manual scan equivalent using the virtual table is:
  ```sql
  SELECT t.id, t.title, t.body, t.kind, v.distance
  FROM t2_vec v
  JOIN t2_memories t ON t.rowid = v.rowid
  WHERE v.embedding MATCH ?
    AND k = ?
  ORDER BY v.distance ASC
  ```
- **Result Fusion Strategy**: **Recommend (ii) Re-rank with Reciprocal Rank Fusion (RRF)**.
  - *Reasoning*: t1 summaries and t2 memories represent entirely different semantic densities. An extracted t2 memory (e.g., "User prefers Rust") is highly concentrated, whereas a t1 session rollup is broad. RRF (`Score = 1 / (k + rank)`) ignores raw magnitude differences and merges results based on their relative standing within their own semantic domain. This prevents highly dense t2 memories from permanently eclipsing relevant but broader t1 logs.
- **Score Normalization**: As noted above, raw cosine scores between t1 and t2 are **not strictly comparable**. A per-tier normalization could work (e.g., z-score normalization), but RRF circumvents the need for complex calibration distributions by relying on positional rank.

## (C) Caller Surface Changes
The caller surface is already prepared for multi-tier results, but currently only observes t1 and t2 data.

- **Verified Paths**:
  - **CLI**: `packages/cli/src/commands/recall.ts:22` (`runRecall()`) and `packages/cli/bin/penumbra.ts:126`.
  - **MCP**: `packages/mcp/src/tools/recall.ts:18` (`recallHandler()`).
  - **Daemon**: `packages/daemon/src/routes/recall.ts:4` (`recallRoute()`).
- **Response Shape**:
  - The `RecallResult` schema (`packages/core/src/schemas/recall.ts:25`) already includes a `tier` discriminator (`'t0' | 't1' | 't2'`).
  - Implementation Note: While the schema allows all three tiers, the current `RecallReader` implementation only populates `t1` and `t2` hits. `t0` hits are never returned, rendering the `include_raw` parameter a no-op at the surface level.
- **Consumers to Update**:
  - `packages/cli/src/commands/recall.ts`: Update tabular display (if added) to show the `tier` and `project_id`.
  - `packages/mcp/src/tools/recall.ts`: The tool already forwards the full `RecallResult` array; the focus is ensuring the LLM understands the distinction between tiers once `t0` is added.
  - **Other consumers (verified absence)**: agentchat does NOT currently invoke recall (per the section A trace). Daemon workers do NOT invoke recall (writers only — t1-rollup, t2-promotion, t0-retention). If new consumers are added during Wave 5, document them here.

## (D) Risk Register
- **Implementation Disconnect (t0)**: Contrary to the schema advertisement, `RecallReader.recall()` does not currently query `t0_events`. Wave 5 must bridge this gap by adding a text-search branch for t0. The two viable strategies are FTS5 (cheaper queries, but each event write incurs an index update — and t0_events is the highest-volume table in the schema) or a LIKE-pattern scan (no write-side cost, but unbounded query latency on growing corpora). The spec recommends FTS5 with a deferred-build option; final choice belongs in the implementation commit.
- **Linear Scoring Bias**: The current implementation at `packages/core/src/readers/recall.ts:98` uses a simple global sort by `score` (derived from L2 distance). This assumes semantic parity between t1 (broad rollups) and t2 (dense memories), which is often false.
- **Cold-Start Failure Mode**: If `t2_memories` has exactly zero rows, the `t2_vec` JOIN returns empty. Current logic is safe against this (`[...t1, ...t2]`), but RRF implementation must maintain this robustness.
- **Embedding Dim Mismatch**: Verified that all tiers share a singleton embedder instance via `packages/core/src/services.ts:87`. Risk of dimension mismatch is low unless the model is swapped without a daemon restart.
- **Backward Compatibility (response ordering)**: Switching from flat global score-sort to RRF will change the order of recall responses for existing callers. The `tier` discriminator field has been part of the response since the schema landed, so consumers SHOULD already key off it; verify no external consumer pins on absolute score order before merging Wave 5 commit 3.

## (E) Recommended Wave 5 Task Split (Additive Commits)
Re-framed: Wave 5 is "ADD t0 implementation and RRF fusion" to complete the existing t1/t2 recall surface.

- **Commit 1: T0 Branch Implementation**
  - Add a t0 branch to `packages/core/src/readers/recall.ts` (parallel to existing t1/t2 branches).
  - Implement text-search for `t0_events` to honor the `include_raw` flag.
- **Commit 2: Unified Interface & RRF Engine**
  - Define the new unified TS interfaces (`RecallHit` already exists but ensure t0 mapping).
  - Implement a `fuseResults(t0, t1, t2)` pure function using the Reciprocal Rank Fusion algorithm.
- **Commit 3: Core Service Integration**
  - Update `RecallReader.recall()` to execute all three tier queries (if `include_raw` is set).
  - Pass the returned sets through `fuseResults()`.
- **Commit 4: Caller Surface Updates**
  - Update CLI (`packages/cli/src/commands/recall.ts`) and MCP to expose the `include_raw` toggle.
