# agentchat daemon-driven dispatch worker — phase 1

**Status:** design approved, awaiting implementation plan
**Date:** 2026-04-26
**Scope:** phase 1 of a two-phase rollout. Phase 2 (bin → thin client + daemon SSE delta streaming) will be specced separately after phase 1 ships.
**Predecessor:** `2026-04-26-agentchat-auto-dispatch-design.md` — auto-dispatch shipped today as in-process bin behavior; this spec moves dispatch out of the bin so headless callers (MCP, cron, webhooks, future cross-agent orchestration) can drive chains without a TTY.

## Problem

`runAutoChain` currently dispatches in-process from the agentchat bin. That works for interactive sessions but blocks on a TTY: a chain cannot run headlessly. The cross-agent orchestration vision — Claude planning, Gemini executing, local LLMs reviewing, all without a human in the loop — is gated on having a dispatcher that runs as a service rather than as a CLI invocation.

## Goals

1. Dispatch can happen in a long-running process with no TTY, no stdin, no human present.
2. Any caller (MCP tool, cron job, webhook, the existing bin) can produce an approved handoff and have it dispatched without further intervention.
3. Exactly-once dispatch per handoff, even if multiple dispatchers race.
4. The interactive bin's snappy live-streaming UX is preserved through phase 1 (regression-free).
5. T0 events emitted by the worker are byte-identical in shape and content to those emitted by the bin's in-process dispatch — observers cannot tell which path drove a given hop.

## Non-goals (phase 1)

- Removing the bin's in-process dispatch path. That happens in phase 2 once the daemon has an SSE delta endpoint and the bin has a subscription client.
- Streaming individual token deltas from the worker through the daemon to any subscriber. T0 still records one final `agent-response` event per hop, as today.
- Retry policies on adapter failure. Errors terminate a chain identically to bin behavior; the user re-mentions to retry.
- A new `failed` handoff status. `completed` with an error in the linked t0 `agent-response` event is sufficient until a downstream consumer demands otherwise.
- A `chain-terminated` t0 event. Polling for absence of `pending|approved|dispatched` handoffs in a conversation is the v1 termination signal.
- Folding the worker into `penumbra start` as a managed subsystem. The worker is its own process for phase 1.
- Reclaiming `dispatched` rows abandoned by a crashed worker. We log a warning at startup; reclamation is an explicit, opt-in flag and is itself optional for phase 1.

## Architecture

```
┌────────────┐                  ┌──────────────────┐                  ┌──────────────────────┐
│ caller     │─POST /chains/────│ penumbra daemon  │                  │ agentchat worker     │
│ (MCP/cron/ │     start        │  (db, t0, hand-  │                  │ (long-running, owns  │
│  bin/web)  │                  │   offs, SSE)     │                  │  adapters)           │
└────────────┘                  │                  │◀── poll/SSE ─────│                      │
       │                        │                  │                  │                      │
       │   POST /handoffs       │                  │                  │  POST /handoffs/X/   │
       │   POST /handoffs/X/    │                  │                  │       claim          │
       │   approve              │                  │                  │  runChatTurn         │
       │                        │                  │                  │  POST agent-prompt + │
       │   GET /handoffs?       │                  │                  │       agent-response │
       │   conv=Y&status=       │                  │                  │                      │
       │   pending,approved,    │                  │                  │                      │
       │   dispatched (poll for │                  │                  │                      │
       │   completion)          │                  │                  │                      │
       └────────────────────────┴──────────────────┴──────────────────┴──────────────────────┘
```

Three actors, one new contract:
- **Daemon** — owns db, handoffs, t0 events. Adds `POST /chains/start`, `POST /handoffs/<id>/claim`, `POST /handoffs/<id>/complete`, `GET /handoffs/events` (SSE), and a `?status=<csv>` filter on `GET /handoffs`. Also gains two additive handoff schema columns (`chain_max_hops`, `chain_trust_mode`).
- **Worker** — new long-running process `agentchat worker`. Subscribes to `/handoffs/events`, drains backlog via polling on startup, claims approved handoffs via the new claim endpoint, calls adapters via the existing `runChatTurn`, writes t0 events back through the daemon.
- **Producers** — anyone who creates an `approved` (or `redirected`) handoff: the existing bin (in-process auto-dispatch, unchanged in phase 1), the new `/chains/start` endpoint, the existing `/handoffs/<id>/approve` endpoint.

The worker's contract is one sentence: **"I dispatch approved handoffs."** Phase 2 will route the bin's interactive dispatch through the worker too, eliminating the parallel path.

## Components and per-package changes

### `packages/daemon`

- **`POST /chains/start`** — new route. Body: `{ initial_agent: string, message: string, conversation_id?: string, project_id?: string | null, max_hops?: number, trust_mode?: 'all' | 'config' }`. Single transaction:
  1. Mint a `conversation_id` if absent.
  2. Write a `user-prompt` t0 event (source `'agentchat'`, source_detail `'chain-start'`, session_id = conversation_id).
  3. Create a handoff with `from='user', to=initial_agent`, transitioned to `status='approved'` atomically with `resolved_by='chain-start'`, `triggered_by_event_id` = the user-prompt event id, `chain_max_hops` and `chain_trust_mode` populated from the request.
  4. Emit `handoffEvents.emit('approved', row)` so any SSE subscriber sees it.
  Returns `{ conversation_id, handoff_id }`.
- **`POST /handoffs/<id>/claim`** — new route. Calls `HandoffWriter.claimDispatch(id)`. 200 on win, 409 on loss with `current_status`, 404 if unknown.
- **`POST /handoffs/<id>/complete`** — new route. Calls `HandoffWriter.markCompleted(id)`. 200 on success, 409 if not in `dispatched`, 404 if unknown. Required so worker-driven handoffs reach `completed` (the polling-for-completion termination signal). Bin-driven chains today never call this; bin behavior is unchanged in phase 1.
- **`GET /handoffs/events`** — new SSE stream. Emits one event per handoff transitioning into `approved` or `redirected`. Payload is the full handoff row. No replay buffer; subscribers drain backlog with a poll.
- **`GET /handoffs` status filter** — extend the existing list route to accept `?status=<csv>` (e.g. `pending,approved,dispatched`). Default behavior (no `status` param) stays `pending`-only for back-compat. Required by completion-polling callers and by the worker's startup drain. Adds a corresponding `HandoffReader.listByStatus(conversation_id, statuses[])` method.
- **In-memory event bus** — `services.handoffEvents` (small EventEmitter-shaped helper). Hooked into `HandoffWriter.approve()` and the chain-start path.
- **Handoff schema additions** — additive migration: `chain_max_hops INTEGER NULL`, `chain_trust_mode TEXT NULL`. Worker treats NULL as "use defaults from CLI flags." Existing rows continue to function.

### `packages/agentchat`

- **`bin/agentchat-worker.ts`** — new binary. Wires `PenumbraClient` for daemon HTTP, an SSE consumer with poll fallback, an in-memory dispatcher with per-conversation lock and N-concurrency semaphore, and `runChatTurn` from the existing adapter pipeline. CLI flags:
  - `--storage-root <path>` (default from `PENUMBRA_STORAGE_ROOT` env)
  - `--daemon-url <url>` (resolved via env or `<storage>/port` file)
  - `--token <token>` (resolved via env or `<storage>/token` file)
  - `--concurrency <n>` (default 4)
  - `--poll-interval <ms>` (default 1000)
  - `--max-hops <n>` (default 8) — fallback when handoff has no `chain_max_hops`
  - `--trust <mode>` (default `all`) — fallback when handoff has no `chain_trust_mode`
- **`src/cli/auto-loop.ts` → `dispatchHandoff` extraction.** Split current `runAutoChain` into:
  - `dispatchHandoff(handoff, opts)` — pure single-hop primitive: takes one approved handoff, runs the receiving agent, writes events, optionally creates the next handoff, returns `{ next: handoff | null, terminatedReason }`. Used by both bin and worker.
  - `runAutoChain(opts)` — current bin entrypoint, now expressed as a loop calling `dispatchHandoff` repeatedly. Public API unchanged so the bin is untouched in phase 1.
- **`src/worker/dispatcher.ts`** — new module: per-conversation `Map<conversation_id, Promise>` lock + global semaphore. Receives handoff events, defers as needed, calls `claim` then `dispatchHandoff`.
- **`src/worker/event-source.ts`** — new module: hybrid SSE-with-poll-fallback consumer. Dedupes by `handoff_id`. Reconnect with jittered backoff (0.5/1/2/5s cap).

### `packages/mcp`

- **`penumbra__chain_start` tool** — thin wrapper around `POST /chains/start`. Returns `{ conversation_id, handoff_id }` so MCP callers can poll for completion.

### `packages/core`

- No code changes. The additive handoff columns land via the daemon migration; `claimDispatch`, `markCompleted`, and the existing reader/writer are already correct for the new flow.

### `packages/cli`

- Unchanged in phase 1. The `penumbra start --workers=…` integration is a future consideration once the worker has settled.

## Data flow

### Headless chain start

```
caller → POST /chains/start { initial_agent, message, project_id, max_hops, trust_mode }
       → daemon: txn { user-prompt t0 event, handoffs row approved with chain_* columns,
                       handoffEvents.emit('approved', row) }
       → returns { conversation_id, handoff_id }
caller polls GET /handoffs?conversation_id=X&status=pending,approved,dispatched
       until result is empty
```

### Worker dispatch loop

```
worker startup
  1. GET /handoffs?status=approved,redirected (drain backlog poll)
  2. Open SSE GET /handoffs/events
  3. On stream error: poll at --poll-interval, retry SSE on jittered backoff

for each (approved | redirected) handoff event:
  if conversation_lock held → defer in memory, retry on lock release
  if global semaphore full → defer in memory, retry on slot release
  acquire conversation_lock + semaphore slot
  POST /handoffs/<id>/claim
    409/404 → release locks, drop event (someone else won)
    200    → status now 'dispatched', we own this hop
  dispatchHandoff(handoff):
    resolve target agent from config (handoff.to)
    build prompt:
      if handoff.from === 'user' (chain-start): raw handoff.message
      else: buildNextPrompt(transcriptForConversation, handoff.from, handoff.message,
                            { maxTokens, projectContext: loadProjectContext() })
    runChatTurn(...)  → writes agent-prompt + agent-response t0 events
    POST /handoffs/<id>/complete
    if turn.next_mention and hopsSoFar+1 < (handoff.chain_max_hops ?? --max-hops):
      POST /handoffs to create next handoff
      if (handoff.chain_trust_mode ?? --trust) == 'all'
         OR auto_approve_to[from] permits to:
        POST /handoffs/<new id>/approve resolved_by='auto'
        → re-enters loop via SSE/poll
      else:
        leave pending; chain pauses, polling caller surfaces it
  release semaphore + conversation_lock
```

### Invariants preserved

- **Exactly-once dispatch when both racers go through `claim`:** `claimDispatch` is the only path to `dispatched`. The worker calls the new `/handoffs/<id>/claim` HTTP wrapper before any LLM work; if it loses the race the event is dropped with no side effect. Note that in phase 1 the *bin* does NOT route through `claim` — see "Coexistence" below — so this invariant only protects worker-vs-worker races, not bin-vs-worker.
- **T0 byte-identical to bin:** `agent-prompt` and `agent-response` events are written by the same `runChatTurn` code, source `'agentchat'`. Worker-driven and bin-driven hops are observationally indistinguishable.
- **Per-conversation serialization:** in-memory lock; one hop per conversation in flight at a time even with N=4 global concurrency.
- **Hop chaining via `triggered_by_event_id`:** unchanged from today.
- **Project context:** worker reads `<storage>/context/<project_id>/latest.md` (already produced by `ContextFileWriter`) and threads it through `buildNextPrompt`. Same source the bin uses today.

## Error handling

| Failure | Behavior |
|---|---|
| Adapter error (network, 5xx, malformed) | `runChatTurn` records error in `agent-response.payload_json.error`. Worker logs, marks handoff `completed`, releases locks. Chain stops. No retry (matches bin). |
| Worker crash mid-dispatch | Handoff stuck at `dispatched`. Worker logs warning at startup if any `dispatched` rows older than 5 minutes exist. Recovery is manual: optional `--reclaim-stale=<duration>` flag flips them back to `approved`. Default v1: don't auto-reclaim. |
| Claim race (409) | Log debug, drop event. No work performed. |
| SSE disconnect | Switch to polling at `--poll-interval`. Retry SSE with jittered backoff (0.5/1/2/5s cap). When SSE returns, polling pauses. |
| Daemon unreachable at startup | Worker retries connect with backoff, logs `daemon unreachable, retrying` once per minute. Does not exit. |
| Trust gate fails on continuation | Next handoff stays `pending`. Chain pauses awaiting human approval. Polling caller sees the pending row. |
| `max_hops` reached | Final handoff stays `pending`. Chain pauses. Caller may approve to bump and continue. |
| Concurrency overflow | Events deferred in memory. On restart, drain-poll re-discovers them via db state. |

### Coexistence with bin's in-process dispatch (phase 1 only)

- Both the bin's `--auto` mode and the worker can produce/dispatch approved handoffs.
- The bin's `runAutoChain` calls `dispatchHandoff` directly without going through `/handoffs/<id>/claim`. The worker does. So `claimDispatch` does NOT actually mediate bin-vs-worker races — it only mediates worker-vs-worker races.
- Soft rule (not a guarantee): don't run `agentchat --auto` and `agentchat worker` against the same conversation simultaneously. If you do, a single approved handoff can be dispatched twice (once by the bin, once by the worker), each emitting its own `agent-prompt`/`agent-response` t0 events.
- Phase 2 routes the bin through the worker — `claim` becomes the single dispatch gate and the rule becomes moot. The integration test `packages/agentchat/test/integration/worker-bin-coexistence.test.ts` is marked `test.skip` for now and will be un-skipped in phase 2 when the guarantee actually holds.

## Observability

| Event | Persisted in t0? | Source / source_detail |
|---|---|---|
| `user-prompt` from `/chains/start` | yes | `agentchat` / `chain-start` |
| `agent-handoff` | yes (already) | unchanged |
| `agent-prompt` | yes (already) | unchanged — written by `runChatTurn` |
| `agent-response` | yes (already) | unchanged — `payload_json.error` set on failure |
| Worker lifecycle (start/stop, SSE reconnect, claim race) | logs only | structured `services.log`; not in t0 |

No new t0 event types in phase 1. No `chain-terminated`. No `handoff-claimed`. No per-token deltas. Phase 2 may add the delta channel; phase 1 stays minimal.

## Testing

TDD throughout: failing test first, run red, implement, run green, commit per logical chunk. Bun ONNX teardown panic is cosmetic — judge by pass/fail counts.

### Unit

- `packages/agentchat/src/cli/dispatch-handoff.test.ts` — single-hop primitive: chain-start `from='user'` (raw message), continuation (transcript-wrapped), no-mention termination, mention with trust=all/config, max-hops, untrusted edge, adapter error, project context threaded.
- `packages/agentchat/src/cli/auto-loop.test.ts` — existing tests stay green; add coverage for each `terminatedReason` propagated from `dispatchHandoff`.
- `packages/agentchat/src/worker/dispatcher.test.ts` — claim called once per event, lost-claim drops silently, per-conversation serialization, N+1 cross-conversation concurrency cap, error in `dispatchHandoff` releases locks.
- `packages/agentchat/src/worker/event-source.test.ts` — healthy SSE delivery, SSE error → poll fallback, dedupe across SSE+poll, reconnect, backoff curve.
- `packages/daemon/src/routes/chains.test.ts` — happy path, caller-supplied `conversation_id`, schema validation 400, single-transaction guarantee under writer failure, `handoffEvents.emit` invoked once.
- `packages/daemon/src/routes/handoffs-claim.test.ts` — 200 on first claim, 409 on second, 404 on unknown.
- `packages/daemon/src/routes/handoffs-complete.test.ts` — 200 when `dispatched`, 409 when not, 404 on unknown.
- Extend existing handoff list-route tests — `?status=pending` matches today's behavior; `?status=approved,dispatched` returns matching rows; missing param defaults to `pending`. Reader-level coverage for `listByStatus(conversation_id, statuses[])`.
- `packages/daemon/src/routes/handoffs-events.test.ts` — no replay on connect, single emit fans out to all subscribers, disconnect stops delivery.
- `packages/daemon/src/writers/handoff-events.test.ts` — subscribe/unsubscribe semantics, ordered delivery.
- Migration test — additive columns present, NULL on existing rows, inserts with new columns succeed.

### Integration (real Bun + real db, mocked adapters)

- `packages/agentchat/test/integration/headless-chain.test.ts` — spin up real daemon (`serve()`) + real worker on a temp storage root, stub adapter returning a `@executor` mention then plain text, call `POST /chains/start`, poll until empty, assert exactly 2× `agent-prompt`/`agent-response`/`agent-handoff` events linked via `triggered_by_event_id`, both handoffs `completed`.
- `packages/agentchat/test/integration/worker-bin-coexistence.test.ts` — same spin-up plus an in-process `runAutoChain` racing the worker; asserts exactly one `agent-response` per hop. **Marked `test.skip` in phase 1** because the bin bypasses `claim` and the guarantee does not yet hold. Phase 2 routes the bin through the worker; un-skip this test when that lands so it locks the guarantee from regressing.

### Manual smoke (document outcome in PR)

1. `agentchat worker --storage-root /tmp/penumbra-live` against the running daemon.
2. Separate terminal, MCP-call `penumbra__chain_start` with `initial_agent='planner'`, message `"@executor: ping"`.
3. Worker logs show two dispatches: planner reply mentions executor → handoff → executor replies → no mention → done.
4. Spot-check sqlite or `penumbra observations` to confirm t0 trail matches a bin-driven chain.

## Open questions / explicitly deferred

- **Worker reclamation of stuck `dispatched` rows.** Deferred to a `--reclaim-stale` flag whose presence in v1 is optional. Default behavior: log warning, do not auto-reclaim.
- **Worker hosted inside `penumbra start`.** Out of scope for phase 1. Reconsider after phase 2 reduces the surface area.
- **`failed` handoff status.** Out of scope until a consumer needs it.
- **`chain-terminated` t0 event.** Out of scope for phase 1; polling for absence-of-work suffices.
- **Per-token delta streaming worker → daemon → bin.** Phase 2.

## Acceptance criteria

Phase 1 ships when:
1. `agentchat worker` runs as a long-running process and dispatches approved handoffs via the daemon.
2. `POST /chains/start` exists and produces an approved first-hop handoff. MCP `penumbra__chain_start` wraps it.
3. `POST /handoffs/<id>/claim` exists and is the worker's exclusive entrypoint to `dispatched`.
4. `GET /handoffs/events` exists and the worker consumes it with poll fallback.
5. The interactive bin's `--auto` path is unchanged; live streaming still works; both integration tests pass green.
6. Headless smoke test produces a t0 trail indistinguishable from bin-driven dispatch.
7. Full repo test suite green.
