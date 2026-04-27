# agentchat daemon-driven dispatch worker — phase 2

**Status:** draft design
**Date:** 2026-04-27
**Scope:** phase 2
**Predecessor:** `2026-04-26-agentchat-daemon-worker-design.md` — phase 1 moved dispatch to a long-running worker but left the bin with a parallel in-process dispatch path. This phase eliminates the parallel path, making the bin a thin client that subscribes to SSE deltas.

## Decisions made post-review

Following a multi-agent review, the following architectural refinements have been adopted:

1.  **Cancellation delivery**: Committed to **Option A** (persistent control channel). The worker subscribes to `/worker/control` for immediate interrupt delivery via `AbortController`.
2.  **Worker crash detection**: Implemented a **heartbeat mechanism**. The worker sends heartbeats every 5s; the daemon broadcasts `chain-end` with `reason: "error"` if a timeout (15s) is exceeded.
3.  **State sync on reconnect**: The daemon caches the **accumulated text of the active hop** and flushes it to new SSE subscribers immediately upon connection.
4.  **Worker→daemon back-pressure**: The worker **batches token deltas** and POSTs them at 100ms intervals instead of per-token to prevent daemon saturation.
5.  **SSE payload efficiency**: Full response text in `hop-end` is now **optional**. Clients reconstruct state from deltas; `text` is provided only as a fallback for reconciliation.
6.  **Event Correlation**: Terminal events (`chain-end`, `hop-end`) now include `chain_id` for robust client-side multiplexing.

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
  - **State Flush**: On connection, the daemon flushes the `hop-start` and all cached `token` deltas for the active handoff to the new subscriber.
  - Events: `hop-start`, `token`, `hop-end`, `chain-end`.
- **`POST /handoffs/:id/progress`** — internal route used by worker. Body: `{ type: 'delta', text: string } | { type: 'done', result: DispatchOutput }`.
- **`GET /worker/control`** — new SSE route for worker management.
  - Events: `cancel`. Payload: `{"conversation_id": string, "handoff_id": string}`.
- **`POST /worker/heartbeat`** — receives worker heartbeats.
- **Watchdog Service**: Tracks worker liveness. If no heartbeat for 15s, marks active handoffs as `failed` and broadcasts `chain-end` with `reason: "error"`.
- **`POST /conversations/:id/cancel`** — signals the worker via `/worker/control`.

### `packages/agentchat`

- **`bin/agentchat.ts`** — thin client refactor.
  - Handles SIGINT by calling `POST /conversations/:id/cancel`.
- **`src/worker/dispatcher.ts`** — extended to report progress.
  - **Batching**: Buffers token chunks and flushes via `progress` every 100ms.
  - **Control Loop**: Subscribes to `/worker/control` on startup to receive cancel signals.
  - **Heartbeat**: Sends `POST /worker/heartbeat` every 5s.
- **`src/sdk/penumbra-client.ts`** — extended with SSE subscription and progress reporting helpers.

### `packages/core`

- **Handoff state extension**: Add `failed` to `HandoffStatusSchema`.
- **Handoff schema additions**: Add `error_message` column to the handoffs table.

## Wire-format / SSE event shapes

### `GET /conversations/:id/stream`

**Event: `token`**
```json
{
  "handoff_id": "uuid",
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
