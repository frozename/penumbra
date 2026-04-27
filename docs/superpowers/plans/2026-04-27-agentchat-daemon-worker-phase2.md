# agentchat daemon-driven dispatch worker — phase 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-27-agentchat-daemon-worker-phase2-design.md`

**Goal:** Eliminate the parallel in-process dispatch path from the `agentchat` bin, making it a thin client that subscribes to SSE deltas for progress. External headless callers can also observe token-by-token progress.

**Architecture:** The `agentchat` bin becomes a thin client that subscribes to a conversation-scoped SSE stream, while the worker pushes single-flight buffered progress updates to the daemon, maintains a heartbeat with a watchdog, and subscribes to a control stream for durable cancellations.

**Tech Stack:** Bun 1.3, TypeScript, bun:sqlite, zod. Tests use `bun:test`. No new deps.

---

## Execution waves (for parallel sub-agent dispatch)

Each task has a `Depends:` line. Tasks within the same wave can run in parallel against the same branch (or each in its own branch if isolation is desired).

| Wave | Tasks | Description |
|---|---|---|
| **1: Recon** | T1 | Confirm current state of dispatch-handoff, daemon SSE handler, worker bootstrap. |
| **2: Core changes** | T2, T3 | Schema additions (`cancel_requested_at`, `error_message`, `failed` status), wire-format constants. |
| **3: Daemon side** | T4, T5, T6, T7 | `/worker/control`, `/handoffs/:id/progress`, watchdog service, hop-state cache. |
| **4: Worker side** | T8, T9 | Heartbeat sender, cancel listener, single-flight progress uploads with coalesce. |
| **5: Bin migration**| T10 | `agentchat.ts` becomes an SSE subscriber; `--thin` flag. |

**Coding standards** (every task):
- TDD: failing test → run red → minimal impl → run green → commit per logical step.
- One test per assertion concept; do not bundle.
- No AI / agent attribution in commit messages — neutral, conventional commits.
- Run `bun test packages/<pkg>/test/<file>.test.ts` for per-file iteration; `bun test` (from repo root) for full suite.

---

## Wave 1: Recon

### Task 1 — Verify existing state
**Depends:** —

**Files:** (Read only)

#### Steps
- [ ] Review `packages/agentchat/src/cli/dispatch-handoff.ts` to understand how the primitive is currently called.
- [ ] Review `packages/daemon/src/routes/handoffs-events.ts` to see the existing SSE handler pattern.
- [ ] Review `packages/agentchat/src/worker/dispatcher.ts` to understand the current worker bootstrap and polling loop.
- [ ] Commit: `docs(plans): acknowledge phase 2 recon complete` (optional, can just check off).

---

## Wave 2: Core Changes

### Task 2 — Schema additions & `failed` status
**Depends:** T1

**Files:**
- `packages/core/src/db/schema.ts`
- `packages/core/src/schemas/handoff.ts`
- `packages/core/test/schemas/handoff.test.ts`

#### Steps
- [ ] Add `error_message` (TEXT) to the `handoffs` table definition in `schema.ts`.
- [ ] Add `cancel_requested_at` (TEXT) to the `conversations` table definition (create if missing, or add to `handoffs` if conversation is just a logical grouping and the table doesn't exist). *(Note: Verify `conversations` table exists, otherwise add to appropriate schema).*
- [ ] Add `'failed'` to the `HandoffStatusSchema` enum in `schemas/handoff.ts`.
- [ ] Add `error_message: z.string().nullable()` to `HandoffRowSchema`.
- [ ] Write failing schema tests in `handoff.test.ts` verifying the new columns and status.
- [ ] Implement and verify tests pass.
- [ ] Commit: `feat(core): add error_message and cancel_requested_at schemas, failed status`

### Task 3 — Wire-format constants for SSE
**Depends:** T1

**Files:**
- `packages/core/src/schemas/sse.ts` (new)
- `packages/core/src/index.ts`

#### Steps
- [ ] Define types/zod schemas for SSE payloads: `hop-start`, `token` (delta), `hop-end`, `chain-end`.
- [ ] Define types for worker control events: `cancel`.
- [ ] Export them from `@penumbra/core`.
- [ ] Commit: `feat(core): define SSE wire-format schemas for phase 2 streaming`

---

## Wave 3: Daemon Side

### Task 4 — Progress route & hop-state cache
**Depends:** T2, T3

**Files:**
- `packages/daemon/src/routes/handoffs-progress.ts` (new)
- `packages/daemon/src/serve.ts`
- `packages/daemon/test/routes/handoffs-progress.test.ts`

#### Steps
- [ ] Implement an in-memory cache in the daemon (e.g. within `Services`) mapping `conversation_id` -> `[{ seq, delta }, ...]`.
- [ ] Create `POST /handoffs/:id/progress` route.
- [ ] Validate body: `{ type: 'delta', text: string, seq: number }` or `{ type: 'done', result: ... }`.
- [ ] Append incoming deltas to the hop-state cache. Emit to an internal event bus.
- [ ] Clear the cache on `hop-end` or `chain-end`.
- [ ] Write tests for the cache logic and progress endpoint.
- [ ] Commit: `feat(daemon): POST /handoffs/:id/progress route and hop-state cache`

### Task 5 — `/conversations/:id/stream` SSE Endpoint
**Depends:** T4

**Files:**
- `packages/daemon/src/routes/conversation-stream.ts`
- `packages/daemon/src/serve.ts`
- `packages/daemon/test/routes/conversation-stream.test.ts`

#### Steps
- [ ] Create `GET /conversations/:id/stream` SSE route.
- [ ] On connection, immediately flush `hop-start` and all cached `token` deltas (in `seq` order) to the subscriber.
- [ ] Subscribe to the internal event bus to pipe live progress updates (`token`, `hop-end`, `chain-end`) to the SSE stream.
- [ ] Wire into `serve.ts`.
- [ ] Write tests verifying state flush on connect and live delta delivery.
- [ ] Commit: `feat(daemon): GET /conversations/:id/stream SSE endpoint`

### Task 6 — `/worker/control` SSE Endpoint & Durable Sync
**Depends:** T2

**Files:**
- `packages/daemon/src/routes/worker-control.ts`
- `packages/daemon/src/routes/conversations.ts` (for cancel)
- `packages/daemon/src/serve.ts`
- `packages/daemon/test/routes/worker-control.test.ts`

#### Steps
- [ ] Create `POST /conversations/:id/cancel` that records cancellation in the DB (`cancel_requested_at`) and emits an internal cancel event.
- [ ] Create `GET /worker/control` SSE route.
- [ ] On connection, query the DB for pending cancellations and emit them immediately to the worker.
- [ ] Subscribe to internal cancel events and pipe them to the stream.
- [ ] Write tests verifying durable sync and live broadcast.
- [ ] Commit: `feat(daemon): GET /worker/control SSE endpoint with durable cancel sync`

### Task 7 — Watchdog Service & `/worker/heartbeat`
**Depends:** T2

**Files:**
- `packages/daemon/src/routes/worker-heartbeat.ts`
- `packages/daemon/src/services/watchdog.ts`
- `packages/daemon/src/serve.ts`
- `packages/daemon/test/services/watchdog.test.ts`

#### Steps
- [ ] Create `POST /worker/heartbeat` route that updates a `lastHeartbeat` timestamp in memory.
- [ ] Create `WatchdogService` (runs every ~10s).
- [ ] If `Date.now() - lastHeartbeat > 60_000`, mark active handoffs as `failed` with `error_message`="worker timeout".
- [ ] Broadcast `chain-end` (reason: "error") to the conversation stream.
- [ ] Wire route and start watchdog in `serve.ts`.
- [ ] Write tests verifying failure cascade on timeout.
- [ ] Commit: `feat(daemon): worker watchdog service and POST /worker/heartbeat`

---

## Wave 4: Worker Side

### Task 8 — Single-flight progress uploads
**Depends:** T4

**Files:**
- `packages/agentchat/src/worker/dispatcher.ts`
- `packages/agentchat/src/sdk/penumbra-client.ts`
- `packages/agentchat/test/worker/dispatcher.test.ts`

#### Steps
- [ ] Add `postProgress(handoffId, payload)` to `PenumbraClient`.
- [ ] Update `dispatcher.ts` to accumulate chunks from `onChunk`.
- [ ] Implement single-flight invariant: buffer tokens while a `postProgress` is in-flight, flush only after the previous returns, min 100ms interval.
- [ ] Assign monotonic `seq` numbers to deltas.
- [ ] Write tests verifying single-flight batching and `seq` incrementing.
- [ ] Commit: `feat(agentchat): single-flight progress uploads with coalesce`

### Task 9 — Heartbeat & cancel listener
**Depends:** T6, T7

**Files:**
- `packages/agentchat/src/worker/dispatcher.ts`
- `packages/agentchat/test/worker/control-loop.test.ts`

#### Steps
- [ ] On worker startup, initiate a `setInterval` calling `POST /worker/heartbeat` every 15s.
- [ ] Subscribe to `GET /worker/control`.
- [ ] On receiving a `cancel` event, map it to the active dispatch's `AbortController` and call `.abort()`.
- [ ] Add safety check: if disconnected from `/worker/control`, pause processing/streaming until reconnected.
- [ ] Write tests simulating a cancel payload and verifying abort propagation.
- [ ] Commit: `feat(agentchat): worker heartbeat sender and cancel listener`

---

## Wave 5: Bin Migration

### Task 10 — Thin client migration
**Depends:** T5, T8, T9

**Files:**
- `packages/agentchat/bin/agentchat.ts`
- `packages/agentchat/src/sdk/penumbra-client.ts`

#### Steps
- [ ] Add `subscribeConversation(id)` to `PenumbraClient` to parse the new SSE schemas.
- [ ] Modify `bin/agentchat.ts` to support a `--thin` flag (default to false during dev, or true to test).
- [ ] If `--thin`, call `client.startChain()`, then use `subscribeConversation()` to print progress dynamically.
- [ ] Parse `hop-start` to reset local accumulators, `token` to print deltas, and `hop-end`/`chain-end` to finalize.
- [ ] Forward `SIGINT` to `client.cancelConversation(id)`.
- [ ] Update bin tests or add E2E to verify the thin flow.
- [ ] Commit: `feat(agentchat): bin migration to thin SSE subscriber via --thin`
