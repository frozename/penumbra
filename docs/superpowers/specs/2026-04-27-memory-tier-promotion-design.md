# Memory Tier Promotion Lifecycle Audit + Design

**Date:** 2026-04-27
**Status:** audit + follow-up design proposal
**Scope:** memory promotion lifecycle audit (`t0 -> t1 -> t2`) and a narrow design for the next implementation round

---

## Background

Penumbra already ships the three-tier storage shape:

- `t0_events` for raw observations
- `t1_rollups` + `t1_vec` for session summaries
- `t2_memories` + `t2_vec` for long-term semantic memory

What is still unresolved is the **promotion lifecycle**:

- what actually moves from `t0` to `t1`
- what actually moves from `t1` to `t2`
- what is retained, recalled, or compacted after promotion

This document is intentionally narrow. It audits the code that exists today and proposes the minimum lifecycle decisions needed for a real `t2` implementation.
## Current State

### T0 today: append-only raw event log

Raw observations land in `t0_events` through `T0Writer.write()`, which is a straight insert with no retention, dedupe, or promotion metadata (`packages/core/src/writers/t0.ts:4-30`).

The daemon's public ingest route normalizes input and writes one `t0` row per request, with no immediate rollup side effect (`packages/daemon/src/routes/observations.ts:4-28`).

Two daemon-owned flows also emit `t0` rows directly:

- `POST /chains/start` writes a `user-prompt` event before creating the initial approved handoff (`packages/daemon/src/routes/chains.ts:19-57`).
- `POST /handoffs` writes an `agent-handoff` event in the same transaction as the mutable handoff row (`packages/daemon/src/routes/handoffs.ts:22-64`).

Important properties of `t0` today:

- `session_id` is nullable, so not every raw event belongs to a promotable session (`packages/core/src/schemas/event.ts:17-38`).
- `t0RetentionDays` exists in settings, but there is no worker or route that uses it (`packages/core/src/settings.ts:3-10`, `packages/core/src/settings.ts:15-31`).
- There is no delete/prune path for `t0_events` in `packages/core/src`, `packages/daemon/src`, or `packages/cli/src` (repo search).

### T1 today: one rollup per session id

`T1Rollup.rollupSession(sessionId)` is the only actual `t0 -> t1` promotion primitive (`packages/core/src/writers/t1.ts:34-140`).

Its current behavior is:

1. Check whether `t1_rollups` already has a row for the session.
2. If a row already exists, return `null` immediately.
3. Read all `t0_events` for that `session_id`, ordered by timestamp.
4. Aggregate counts and excerpts.
5. Embed only `firstPrompt + lastResponse` (or `"empty session"`).
6. Insert one `t1_rollups` row and one `t1_vec` row.
7. Keep all source `t0` rows intact.

That logic is backed by a unique index on `t1_rollups(session_id)`, so the implementation is explicitly "one session id maps to at most one t1 row" (`packages/core/src/db/schema.ts:54-73`, especially `:73`; `packages/core/src/writers/t1.ts:38-45`, `packages/core/src/writers/t1.ts:98-139`).

The stored `t1` payload contains:

- coverage timestamps (`started_at`, `ended_at`)
- count summaries (`n_events`, lane/provider/token/cost totals)
- excerpts (`first_prompt_excerpt`, `last_response_excerpt`)
- tool summary
- `source_event_ids` as a JSON list of covered `t0` event ids

See schema shape in `packages/core/src/db/schema.ts:54-73` and the zod row contract in `packages/core/src/schemas/rollup.ts:4-21`.
### T0 -> T1 triggers today

There are only two trigger paths:

1. **Idle-session worker**
   - The daemon registers `createRollupWorker()` on startup (`packages/daemon/src/serve.ts:87-97`).
   - The worker calls `detectIdleSessions()` and then `rollupSession()` (`packages/daemon/src/workers/t1-rollup.ts:10-40`).
   - Idle detection selects sessions whose `MAX(t0.ts)` is older than the configured cutoff and that do not already have a `t1` row (`packages/core/src/writers/t1.ts:142-156`).
   - Defaults are 60s poll interval and 10 idle minutes (`packages/core/src/settings.ts:3-10`).

2. **Explicit manual flush**
   - `POST /sessions/end` runs a synchronous `rollupSession(session_id)` (`packages/daemon/src/routes/session-end.ts:7-36`).
   - The MCP tool `session.end` is just a thin wrapper around that daemon route (`packages/mcp/src/tools/session-end.ts:5-16`).

There is no third trigger in the shipped code:
- no project-wide flush
- no shutdown flush
- no transcript-watcher-owned promotion path in this repo slice
- no `t1` rebuild/reopen path for sessions that already rolled once
### Context file behavior today

After a successful `t1` write, the daemon rewrites `<storage>/context/<project_id>/latest.md` using the latest `t1_rollups` and `t2_memories` rows for that project (`packages/daemon/src/workers/t1-rollup.ts:27-35`, `packages/daemon/src/routes/session-end.ts:24-35`, `packages/core/src/context-file/writer.ts:31-93`).

Important constraints:
- context files are only rewritten after `t1` promotion, not after raw `t0` ingest
- rewrite only happens when the landed `t1` row has a non-null `project_id`
- `t2` would appear in the context file if rows existed, but today nothing writes them

### T2 today: schema exists, write path does not

`t2_memories` and `t2_vec` are created by migrations (`packages/core/src/db/schema.ts:75-90`, `packages/core/src/db/schema.ts:122-123`).

The data is also read in two places:

- `RecallReader.recall()` queries both `t1_vec` and `t2_vec`, merges the results, and returns the combined ranking (`packages/core/src/readers/recall.ts:14-99`).
- `ContextFileWriter.rewrite()` reads recent `t2_memories` rows and would render them under "Cross-session memories" (`packages/core/src/context-file/writer.ts:47-55`, `packages/core/src/context-file/writer.ts:71-74`).

But in the audited code there is no:

- `T2Writer`
- `T2PromotionWorker`
- route that writes `t2_memories`
- MCP tool that writes `t2_memories`
- daemon bootstrap that schedules `t1 -> t2`

In current production behavior, `t2` is a declared storage tier with read/query support but no producer.

### Recall semantics today

Recall is not a three-tier search in practice.

The request schema advertises `tier: 't0' | 't1' | 't2'` in results and accepts `include_raw` in the request (`packages/core/src/schemas/recall.ts:4-23`).

However, `RecallReader.recall()` only queries `t1_vec` and `t2_vec`; it never reads `t0_events`, and it never branches on `include_raw` (`packages/core/src/readers/recall.ts:21-99`).

So current semantics are:

- `t0` is **not recallable** via the semantic recall route
- `include_raw` is currently a no-op API field
- merged recall is effectively "`t1` plus any future `t2`"

## Gaps Identified

### 1. No `t1 -> t2` promotion path exists

This is the largest gap. `t2` tables, vectors, metrics, export/import, and context-file reads exist, but nothing populates them (`packages/core/src/db/schema.ts:75-90`, `packages/core/src/readers/recall.ts:69-93`, `packages/core/src/context-file/writer.ts:47-55`).

Practical consequence: every `t1` row is currently an orphan with respect to `t2`.

### 2. A session is permanently sealed after its first `t1` rollup

`rollupSession()` returns early if any `t1_rollups.session_id` row already exists, and idle detection excludes such sessions from future work (`packages/core/src/writers/t1.ts:38-45`, `packages/core/src/writers/t1.ts:147-153`).

Practical consequence: if new `t0` events arrive later with the same `session_id`, they remain raw forever and never affect `t1`, `t2`, recall, or the context file.

### 3. Session-less `t0` events have no promotion path

Because `t1` promotion is session-based, any event with `session_id = null` is outside the current lifecycle (`packages/core/src/schemas/event.ts:26`, `packages/core/src/writers/t1.ts:46-56`, `packages/core/src/writers/t1.ts:147-151`).

This is especially relevant for ingestion sources that can emit useful observations without a stable session boundary.

### 4. Retention policy is declared but not implemented

`t0RetentionDays` exists in settings (`packages/core/src/settings.ts:3-10`), but there is no pruning worker and no deletion path for `t0_events`.

Practical consequence: raw storage grows without bound even after `t1` promotion.

### 5. Recall API and implementation disagree

`include_raw` suggests that callers can opt into `t0` recall, but the implementation ignores it (`packages/core/src/schemas/recall.ts:4-10`, `packages/core/src/readers/recall.ts:21-99`).

This is both an operator confusion issue and a lifecycle ambiguity: if `t0` is retained, is it for audit only or also for retrieval?

### 6. No manual flush exists beyond single-session `session.end`

Current manual control is narrow:

- yes: flush one session synchronously (`packages/daemon/src/routes/session-end.ts:7-36`)
- no: flush all idle sessions now
- no: rebuild `t1` from raw
- no: trigger `t1 -> t2`
- no: compact or prune by policy

### 7. `t1` coverage is tracked, but not used as lifecycle state

`source_event_ids` is stored on every `t1` row (`packages/core/src/db/schema.ts:70`, `packages/core/src/writers/t1.ts:123`), but nothing uses that coverage information for:

- incremental reroll
- `t2` candidate selection
- retention safety checks
- raw inclusion/exclusion in recall

## Proposed Lifecycle

### Design principles

1. `t0` remains the audit/source-of-truth log until an explicit retention policy removes data.
2. `t1` is the session-window layer, not the final memory layer.
3. `t2` is a separate promotion step from `t1`, never a side effect of raw ingest.
4. Promotion state must be explicit. "Exists somewhere" is not enough to answer whether a row is covered, promotable, or safe to prune.
5. The first follow-up implementation should solve lifecycle correctness before it solves ranking quality.

### Proposed flow

```text
raw event arrives
  |
  v
write t0_events row
  |
  +--> session_id is null?
  |      |
  |      +--> yes: keep in t0 only
  |               eligible for audit/raw recall only
  |
  +--> no: session enters/updates "open t1 candidate" state
          |
          +--> trigger fires?
                 - explicit session.end
                 - idle timeout
                 - operator/manual flush
                 |
                 v
             t0 -> t1 promotion
                 - compute coverage window
                 - write/update t1 row + t1_vec
                 - record promotion state/coverage
                 - rewrite project context file
                 |
                 v
             t1 candidate pool
                 |
                 +--> t2 policy says "not yet"
                 |      |
                 |      +--> remain recallable as t1
                 |
                 +--> t2 policy says "promote"
                        |
                        v
                    t1 -> t2 promotion
                        - select one or more t1 rows
                        - synthesize durable memory record
                        - write t2_memories + t2_vec
                        - record provenance back to source t1 rows
                        |
                        v
                    retention/compaction phase
                        - t0 prune only if policy allows
                        - t1 prune only if policy allows
                        - t2 retained as long-term layer
```

### Minimal policy proposal

#### `t0 -> t1`

- Keep the existing two triggers: idle timeout and explicit `session.end`.
- Add one more operator path: manual flush of all currently idle/unrolled sessions.
- Replace the current "one immutable `t1` row per session id" assumption with an explicit coverage model.

This spec does **not** choose the exact storage shape yet. That is the next implementation decision. Viable options are:

- reroll-in-place for a session
- append multiple `t1` windows per session
- maintain a per-session high-water mark over covered `t0` events

What matters at this stage is the invariant:

> No `t0` event with a non-null `session_id` should become permanently unpromotable just because an earlier rollup already exists for that same session id.

#### `t1 -> t2`

- Introduce a dedicated `t2` promotion worker or explicit operator command.
- Make `t2` promotion batch-oriented and project-scoped, not synchronous with `session.end`.
- Promote from `t1` only. Do not synthesize `t2` directly from raw `t0`.
- Record provenance from `t2` back to the source `t1` rows so recall/audit/retention decisions are inspectable.

Candidate triggers for the first implementation round:

- periodic scan for unpromoted `t1` rows
- optional operator-triggered flush

Candidate selection/ranking is intentionally deferred. The first version can be simple as long as promotion state is correct and visible.

#### Retention

- Keep `t0` after `t1` rollup by default.
- Do not delete `t0` as a side effect of `t0 -> t1`.
- Implement retention as a separate policy worker, gated by explicit settings and promotion coverage checks.
- Treat `t0RetentionDays` as non-binding until a real retention worker exists.

#### Recall semantics

- Clarify whether `t0` is recallable or audit-only.
- If recallable, implement `include_raw` for real.
- If not recallable, remove `include_raw` from the API and document that raw search is a different operator surface.

This decision should land before retention work, because retention safety depends on whether `t0` has a user-facing retrieval contract.

## Open Questions

1. Should a session map to exactly one mutable `t1` row, or to multiple immutable `t1` windows over time?
2. What is the real eligibility rule for `t1 -> t2`: age, explicit importance, quality score, project-level batch size, or some combination?
3. Is `t0` part of user-facing recall semantics, or only an audit log?
4. When `t2` exists, should old `t1` rows remain recallable indefinitely, or does `t2` eventually supersede them for some classes of memory?
5. What should happen to `session_id = null` events: remain raw forever, be grouped by another key, or be excluded from promotion by design?
6. Does `session.end` mean "close this session permanently", or only "roll up what exists right now"?
7. Should context files eventually include raw/unrolled session state, or remain a `t1 + t2` view only?

## Recommended Next Step

The next implementation spec should focus on **promotion state and coverage bookkeeping**, not on summarization quality. Until the system can answer "which `t0` rows are covered by which `t1` rows, and which `t1` rows are covered by which `t2` memories?", every retention and recall policy stays ambiguous.
