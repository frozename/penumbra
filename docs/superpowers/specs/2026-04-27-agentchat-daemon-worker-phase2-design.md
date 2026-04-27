# agentchat daemon-driven dispatch worker — phase 2

**Status:** draft design
**Date:** 2026-04-27
**Scope:** phase 2
**Predecessor:** `2026-04-26-agentchat-daemon-worker-design.md` — phase 1 moved dispatch to a long-running worker but left the bin with a parallel in-process dispatch path. This phase eliminates the parallel path, making the bin a thin client that subscribes to SSE deltas.

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
  - Events: `hop-start`, `token`, `hop-end`, `chain-end`.
  - Fans out events received from the worker.
- **`POST /handoffs/:id/progress`** — new internal route used by the worker. Body: `{ type: 'delta', text: string } | { type: 'done', result: DispatchOutput }`.
  - Pushes progress to the daemon's in-memory bus for the conversation linked to the handoff.
- **`POST /conversations/:id/cancel`** — new route. Signals the worker to abort the active handoff/chain for this conversation.
- **In-memory stream bus** — `services.conversationEvents`. Manages subscriptions for active conversation streams.

### `packages/agentchat`

- **`bin/agentchat.ts`** — thin client refactor.
  - Removes `runChatTurn` and `runAutoChain`.
  - On `new` or `resume`: calls `POST /chains/start` or `POST /handoffs/:id/approve`.
  - Subscribes to `/conversations/:id/stream` and renders to TTY.
  - Handles SIGINT (Ctrl-C) by calling `POST /conversations/:id/cancel`.
- **`src/worker/dispatcher.ts`** — extended to report progress.
  - When `dispatchHandoff` calls `runChatTurn`, it passes an `onChunk` callback.
  - `onChunk` calls `POST /handoffs/:id/progress` with type `'delta'`.
  - On completion, it calls `progress` with type `'done'`.
  - Listens for cancellation signals (e.g. via AbortSignal or long-polling/SSE from daemon).
- **`src/sdk/penumbra-client.ts`** — extended with:
  - `subscribeConversation(id: string)`: Async generator for conversation SSE events.
  - `reportProgress(handoffId: string, progress: any)`: POSTs to `/handoffs/:id/progress`.
  - `cancelConversation(id: string)`: POSTs to `/conversations/:id/cancel`.

### `packages/core`

- **Handoff state extension**: Add `failed` to `HandoffStatusSchema` (moving it from phase 3 to phase 2 to support explicit failure reporting).
- **Handoff schema additions**: Add `error_message` column to the handoffs table.

## Wire-format / SSE event shapes

### `GET /conversations/:id/stream`

All events are SSE-formatted.

**Event: `hop-start`**
```json
{
  "handoff_id": "uuid",
  "agent": "executor",
  "ts": "iso-date"
}
```

**Event: `token`**
```json
{
  "handoff_id": "uuid",
  "delta": " Hello"
}
```

**Event: `hop-end`**
```json
{
  "handoff_id": "uuid",
  "text": "Full response text...",
  "next_handoff_id": "uuid" | null,
  "error": "Error message" | null
}
```

**Event: `chain-end`**
```json
{
  "reason": "completed" | "error" | "cancelled" | "max_hops"
}
```

## Migration plan

1. **Side-by-side deployment**: Add a `--thin` flag to `agentchat`. When present, it uses the SSE path.
2. **Default toggle**: Once `--thin` is verified stable in integration tests, flip the default. The old logic can remain behind a `--local-dispatch` flag for a grace period.
3. **Deprecation**: Remove `--local-dispatch` and its supporting code in a follow-up version.

## Out of scope

- Multi-subscriber conflict resolution (e.g. if two people subscribe to the same conversation). The stream is "broadcast" to all.
- Replaying historical token deltas. The SSE stream is live-only. Polling t0 is the way to get historical final text.
- Token-level usage/cost reporting in the delta stream. T0 events written at the end of the hop remain the source of truth for accounting.

## Open questions

1. **Cancellation delivery**: How does the worker know to stop?
   - Option A: Worker subscribes to a `/worker/control` SSE stream from the daemon.
   - Option B: Worker checks a `cancelled` flag in the db before/during long-running steps (polling).
2. **Back-pressure**: If the bin/subscriber is slow, does the worker block?
   - SSE is usually fire-and-forget for the server. The worker should not be blocked by slow clients.
3. **Authentication for Streaming**: Does the `/conversations/:id/stream` endpoint require same-token auth as other routes? (Yes, for consistency).
4. **Resuming an interrupted stream**: If the bin crashes and restarts, it sees the final text of completed hops via t0, but can it "re-attach" to a live hop?
   - Yes, it should poll for the most recent `dispatched` handoff and then subscribe.
