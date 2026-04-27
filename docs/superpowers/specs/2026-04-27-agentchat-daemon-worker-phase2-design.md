# agentchat daemon-driven dispatch worker — phase 2

**Status:** draft design
**Date:** 2026-04-27
**Scope:** phase 2
**Predecessor:** `2026-04-26-agentchat-daemon-worker-design.md` — phase 1 moved dispatch to a long-running worker but left the bin with a parallel in-process dispatch path. This phase eliminates the parallel path, making the bin a thin client that subscribes to SSE deltas.

## Decisions made post-review

Following a multi-agent review, the following architectural refinements have been adopted:

### Round 1 (Initial Review)

1.  **Cancellation delivery**: Committed to **Option A** (persistent control channel). The worker subscribes to `/worker/control` for immediate interrupt delivery via `AbortController`.
2.  **Worker crash detection**: Implemented a **heartbeat mechanism**. The worker sends heartbeats every 5s; the daemon broadcasts `chain-end` with `reason: "error"` if a timeout is exceeded.
3.  **State sync on reconnect**: The daemon caches the **accumulated text of the active hop** and flushes it to new SSE subscribers immediately upon connection.
4.  **Worker→daemon back-pressure**: The worker **batches token deltas** and POSTs them at 100ms intervals instead of per-token to prevent daemon saturation.
5.  **SSE payload efficiency**: Full response text in `hop-end` is now **optional**. Clients reconstruct state from deltas; `text` is provided only as a fallback for reconciliation.
6.  **Event Correlation**: Terminal events (`chain-end`, `hop-end`) now include `chain_id` for robust client-side multiplexing.

### Round 2 (sequencing/durability/back-pressure)

1.  **Token Sequencing**: Every `token` delta event includes a monotonic `seq` number. Clients verify contiguity; gaps trigger a re-fetch of the hop's cached state from the daemon.
2.  **Idempotent `hop-start`**: Defined as a reset marker. Upon (re)connection, the daemon emits `hop-start` followed by all cached deltas in `seq` order. `hop-start` signals the client to clear its local accumulator for that hop.
3.  **Durable Cancellation**: Cancellation requests are persisted in the daemon database (e.g., `conversations.cancel_requested_at`). On worker (re)connect to `/worker/control`, the daemon immediately emits any pending cancellations.
4.  **Heartbeat/Timeout Widening**: Heartbeat widened to 15s / Timeout to 60s to accommodate environment stalls (laptop sleep, GC). If a late `done` arrives after timeout but before a new worker picks up the task, it is rejected if `chain-end` was already broadcast. A disconnected worker MUST stop streaming until it reconnects.
5.  **Single-flight Back-pressure**: The worker maintains a **single-flight invariant** for progress POSTs. While a `progress` POST is in flight, new tokens accumulate; they are only sent in the *next* batch after the previous POST completes.

## Problem

Phase 1 successfully introduced the `agentchat worker` and `POST /chains/start`, allowing headless dispatch. However, the interactive `agentchat` bin still contains the heavy `runChatTurn` and `runAutoChain` logic. This creates two problems:
1. **Parallel paths**: Any change to prompt assembly or adapter logic must be verified across both the bin and the worker.
2. **Missing streaming for headless callers**: While the bin streams locally, external callers (MCP, webhooks) have no way to observe the live progress (token-by-token) of a chain driven by the worker. They can only poll for hop-level completion.

## Approach

1. **Centralized Dispatch**: The bin's in-process dispatch path is removed. All `agentchat` turns are dispatched by the worker.
2. **Thin Bin**: The `agentchat` bin becomes a pure UI layer. It initiates chains/handoffs and subscribes to a new conversation-scoped SSE stream to display progress.
3. **Progress Reporting**: The worker gains the ability to report turn-level progress (tokens, internal state) back to the daemon.
4. **Delta Streaming**: The daemon gains a subscription endpoint that multiplexes worker progress into a single stream for a conversation.

## Components and per-package changes

### `packages/daemon`

- **`GET /conversations/:id/stream`** — new SSE route. Emits events for a specific conversation.
  - **State Flush**: On connection, the daemon flushes the `hop-start` (reset marker) and all cached `token` deltas (in `seq` order) for the active handoff to the new subscriber.
  - Events: `hop-start`, `token`, `hop-end`, `chain-end`.
- **`POST /handoffs/:id/progress`** — internal route used by worker. Body: `{ type: 'delta', text: string, seq: number } | { type: 'done', result: DispatchOutput }`.
- **`GET /worker/control`** — new SSE route for worker management.
  - **Durable Sync**: On connection, the daemon flushes all pending cancellations (from `conversations.cancel_requested_at`).
  - Events: `cancel`. Payload: `{"conversation_id": string, "handoff_id": string}`.
- **`POST /worker/heartbeat`** — receives worker heartbeats.
- **Watchdog Service**: Tracks worker liveness.
  - **Config**: 15s heartbeat interval / 60s timeout.
  - **Action**: If timeout exceeded, marks active handoffs as `failed` and broadcasts `chain-end` with `reason: "error"`.
- **`POST /conversations/:id/cancel`** — records cancellation in DB and signals the worker via `/worker/control`.

### `packages/agentchat`

- **`bin/agentchat.ts`** — thin client refactor.
  - Handles SIGINT by calling `POST /conversations/:id/cancel`.
- **`src/worker/dispatcher.ts`** — extended to report progress.
  - **Back-pressure**: Implements **single-flight POST**. Buffers tokens while a POST is in flight; flushes remaining buffer only after previous POST returns (min 100ms interval).
  - **Control Loop**: Subscribes to `/worker/control` on startup. **Safety**: If disconnected from `/worker/control`, the worker MUST pause streaming/execution until reconnected.
  - **Heartbeat**: Sends `POST /worker/heartbeat` every 15s.
- **`src/sdk/penumbra-client.ts`** — extended with SSE subscription and progress reporting helpers.

### `packages/core`

- **Handoff state extension**: Add `failed` to `HandoffStatusSchema`.
- **Schema additions**:
  - `handoffs.error_message` (text).
  - `conversations.cancel_requested_at` (datetime) — durable cancellation marker.

## Wire-format / SSE event shapes

### `GET /conversations/:id/stream`

**Event: `hop-start`**
```json
{
  "handoff_id": "uuid",
  "chain_id": "uuid",
  "idx": 0,
  "agent_name": "gemini-pro",
  "status": "in_progress"
}
```

**Event: `token`**
```json
{
  "handoff_id": "uuid",
  "seq": 42,
  "delta": " accumulated batch text..."
}
```

**Event: `hop-end`**
```json
{
  "handoff_id": "uuid",
  "chain_id": "uuid",
  "text": "Full response text...", // Optional: for reconciliation
  "next_handoff_id": "uuid" | null,
  "error": "Error message" | null
}
```

**Event: `chain-end`**
```json
{
  "chain_id": "uuid",
  "reason": "completed" | "error" | "cancelled" | "max_hops"
}
```

## Out of scope

- Multi-subscriber conflict resolution.
- Replaying historical token deltas (except for the current active hop state flush).
- Token-level usage/cost reporting in the delta stream.
