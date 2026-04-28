# Phase 3a — Dispatch t0 Capture: Design Spec

**Date:** 2026-04-29
**Scope:** Persist ACP `session/update` notifications from dispatched agent turns as `t0_events` so the existing recall surface can return chain-of-thought content alongside summaries and durable memories.
**Predecessors:**
- [Wave 5 Recall: t0 Retrieval & RRF Fusion](./2026-04-27-wave5-recall-t0-rrf-fusion.md) — t0 retrieval + RRF fusion already wired into `RecallReader`.
- [Phase 1d Write Tools](./2026-04-28-phase-1d-write-tools-design.md) — provides the discipline patterns (single-writer authority, best-effort observability layered onto essential paths) this phase reuses.

---

## Goal

Today, when a dispatched agent runs a turn, the worker's `runChatTurn` (`packages/agentchat/src/cli/loop.ts`) already persists exactly two t0 events per turn: an `agent-prompt` row at the start and an `agent-response` row at the end (the accumulated final text). It does this via an `observe(event) => Promise<{event_id}>` callback supplied by the worker host, which is the existing worker → daemon → `T0Writer` path.

What is **not** persisted is everything that happens **between** prompt and response: ACP `session/update` notifications carrying `agent_message_chunk`, `agent_thought_chunk`, and `tool_call`/`tool_call_update` flow through the adapter, get accumulated into the final response string, and are then discarded. The agent's reasoning trail and tool-use record are lost.

This phase closes that gap. After this phase, every ACP-dispatched turn additionally writes:
- coalesced agent thoughts (`agent-thought` rows; new event_type) where the agent emits them as a separate stream,
- tool-call invocations (`agent-tool-use` rows with start args + terminal result merged into one row each).

The existing `agent-prompt` and `agent-response` events continue to be written by `runChatTurn` unchanged. (A future refinement could add per-message granularity to the response — capturing intermediate distinct messages within a turn rather than only the accumulated final text — but that is out of scope for Phase 3a; today's single accumulated response row is preserved.)

Recall over chain-of-thought becomes a first-class capability: existing `memory.recall` returns relevant CoT moments via FTS5 over `t0_events.payload_json`, and gains optional `session_id` and `event_types` filters so consumers can scope to a specific chain or filter by event class.

## Non-goals

- Scoring or summarising CoT content. (Out of scope: any LLM-based postprocessing of dispatch events. They are stored verbatim, truncated where noted.)
- New replay/transcript MCP tools (e.g. `chain_get_cot`). Noted as a separable future feature; not blocking this phase.
- Capturing non-ACP dispatch paths (e.g. the existing SDK adapter used by Claude Code over plain stdin/stdout). The `CapturePort` design admits a future SDK-adapter integration with no daemon-side change, but wiring it is out of scope for Phase 3a.
- Reshaping the existing `observe()` callback or its host-side implementation. The CapturePort uses it as-is.
- Backfill of historical dispatches. Only events emitted after this lands are persisted.

## Decisions Locked During Brainstorm

The brainstorming session reached the following decisions, in order. Each is reflected in the design below.

| # | Decision | Choice |
|---|---|---|
| 1 | Capture scope | New rows for `agent_thought_chunk` (coalesced) + `tool_call`/`tool_call_update` (merged terminal). `agent-prompt` and `agent-response` rows already written by `runChatTurn` are kept as-is. |
| 2 | Granularity | Per-message coalesced (chunks buffered until next-event boundary or turn-end; tool_call lifecycle merged into a single terminal row) |
| 3 | Write path | Reuse the existing `observe()` callback that `runChatTurn` already uses. The CapturePort calls `observe()` non-blocking (`void observe(...)`) at coalesce boundaries; outstanding promises tracked for `flush()`. **No new daemon route.** Single-writer property preserved through the existing path. |
| 4 | `session_id` mapping | `chain_id` if present, else `handoff_id`. `handoff_id` always also stamped in `payload_json.handoff_id` |
| 5 | Failure mode | `void observe(...)` so the dispatch turn never blocks on capture. A `.catch()` on the promise logs and increments a counter — capture failures never fail the turn. (Existing `await observe(...)` on prompt/response is intentionally kept: those events are essential to a coherent turn record; mid-turn CoT is observability and is best-effort.) |
| 6 | `agent_thought_chunk` schema | New `'agent-thought'` value added to `EventTypeSchema` enum (own discriminator, not folded into `'agent-response'`) |
| 7 | `tool_call` shape | One row per tool call at terminal state, args + output merged, 8 KB cap each on `input` and `output` with `truncated` + `bytes_total` flags |
| 8 | Recall consumer surface | Capture + extend `memory.recall` and `RecallReader.recall()` with optional `session_id` and `event_types` filters |

## Architecture

```
┌─────────────────┐
│ chain_start /   │   dispatch                 ┌─────────────────────────┐
│ handoff entry   │ ───────────────────────►  │ agentchat-worker (proc) │
└─────────────────┘                            │  runChatTurn:           │
                                               │   awaits observe(prompt)│
                                               │   ┌──────────────────┐  │
                                               │   │   CapturePort    │  │
                              fork ACP server  │   │  (per-dispatch)  │  │
                                               │   │ buffer/coalesce  │  │
                                               │   │ void observe(...)│  │
                                               │   └────────▲─────────┘  │
                                               │            │ emit()      │
                                               │   ┌────────┴─────────┐  │
                                               │   │  stdio-acp       │  │
                                               │   │  adapter         │  │
                                               │   └────────▲─────────┘  │
                                               │            │ session/update│
                                               │   ┌────────┴─────────┐  │
                                               │   │  ACP CLI (agent) │  │
                                               │   └──────────────────┘  │
                                               │  awaits observe(resp.)  │
                                               └────────────┬────────────┘
                                                            │ observe()
                                                            │ (existing path,
                                                            │  unchanged)
                                                            ▼
                                               ┌─────────────────────────┐
                                               │  penumbra daemon        │
                                               │     ↓                   │
                                               │  T0Writer.write()       │
                                               │  (single-writer txn)    │
                                               │     ↓                   │
                                               │  t0_events + FTS5       │
                                               └─────────────────────────┘
                                                            ▲
                                                            │  reads via
                                                            │  RecallReader
                                                            │  (Wave 5 RRF)
                                               ┌────────────┴────────────┐
                                               │  memory.recall (MCP)    │
                                               │  + new args:            │
                                               │   session_id?           │
                                               │   event_types?          │
                                               └─────────────────────────┘
```

Key topological properties:
- **Single-writer** for `t0_events` preserved — daemon owns the table; the existing `observe()` path is the only mutator.
- **No new daemon route.** All new events flow through the same `observe()` callback that `runChatTurn` already uses for prompt/response.
- **Adapter-agnostic** capture surface — `CapturePort` is the contract; future adapters emit through it.
- **Non-blocking by default for mid-turn events** — the port calls `void observe(...)`. A capture failure is caught and logged but never fails the dispatch turn. Existing `await observe(...)` on prompt/response is unchanged.
- **Schema-coherent** — uses existing `T0EventInputSchema` plus one enum addition (`agent-thought`).

## Components

### New files

#### `packages/agentchat/src/worker/capture-port.ts`

A worker-process abstraction for buffering, coalescing, and emitting dispatch events through the existing `observe()` callback. The port does not own the network primitive — it composes coalescing logic on top of `observe()`.

Public surface:

```ts
export interface CapturePortOpts {
  // The same observe() callback runChatTurn already uses. Re-bound for the port
  // so capture flows through one path, and the port can wrap each call in try/catch.
  observe: (event: any) => Promise<{ event_id: string }>;
  // Provenance, stamped onto every emitted event:
  chainId: string | null;     // null for ad-hoc handoffs (uses handoffId for session_id)
  handoffId: string;
  projectId: string | null;
  agentName: string;          // → t0 source_detail
  provider: string | null;
  model: string | null;
  lane: 'local' | 'cloud' | 'cli-subscription' | 'unknown';
}

export interface NotificationEvent {
  kind: 'agent_message_chunk' | 'agent_thought_chunk'
      | 'tool_call' | 'tool_call_update';
  toolCallId?: string;             // for tool_call*
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
  content?: string;                // for chunks
  input?: unknown;                 // for tool_call (start)
  output?: unknown;                // for tool_call_update (terminal)
}

export class CapturePort {
  constructor(opts: CapturePortOpts);
  emit(ev: NotificationEvent): void;     // sync, never throws
  flush(): Promise<void>;                // call at turn-end; flushes open buffers and awaits outstanding promises
  close(): Promise<void>;                // final flush + drain
  getStats(): { sent: number; failed: number };
}
```

Internal coalescing rules:

- **Per-kind chunk buffer.** Chunks of the same `kind` (`agent_message_chunk` or `agent_thought_chunk`) accumulate in a `string` buffer keyed by kind. A buffer flushes (emits one t0 row via `observe`) when an event arrives whose kind differs from that buffer's kind — whether that new event is a chunk of a different kind (e.g. a `agent_thought_chunk` arriving while the message buffer is open) or a non-chunk event (`tool_call`, `tool_call_update`). This preserves interleaving boundaries between distinct streams. A buffer also flushes on `flush()` (turn-end) and `close()` (shutdown).
- **Per-tool-call merge.** A `tool_call` with `status` other than terminal is held in a `Map<toolCallId, PendingToolCall>`. On a `tool_call_update` with terminal status (`completed`/`failed`/`canceled`), the held start is merged with the terminal update into one event with `latency_ms = terminal_ts - start_ts` and emitted as a single t0 row of `event_type: 'agent-tool-use'`.
- **Orphan handling.** If `flush()` runs while pending tool_calls remain, each is emitted as a `'canceled'` row with `output: null`, `payload_json.lifecycle: 'orphaned'`, and `latency_ms = now() - start_ts`. This prevents truncation of the recall surface when an agent CLI crashes mid-tool-call.
- **Truncation.** Both `payload_json.input` and `payload_json.output` are clamped to 8 KB (after JSON serialization). When clamping occurs the value is replaced with the truncated prefix and two flags are added: `truncated: true`, `bytes_total: <original size>`.

Emit semantics (the load-bearing detail):

- `emit()` is **synchronous and never throws**. It only updates internal coalescing state.
- When a coalescer flushes (chunk-buffer flush, tool_call merge, orphan, or `flush()`/`close()`), the port builds a `T0EventInput` and calls `observe(event)` **without awaiting** (`void observe(event).then(...).catch(...)`).
- Each in-flight promise is tracked. The `.catch()` increments `failed` and logs `capture-port: observe failed: <error>` to stderr. **No retry.** A capture failure is best-effort; the dispatch turn is unaffected.
- `flush()` awaits `Promise.allSettled(<all outstanding promises>)` so callers (e.g. integration tests, `close()`) can deterministically observe completion.
- `close()` calls `flush()`, then prevents further `emit()` calls.

This is the entire CapturePort — coalescing logic + non-blocking emit through the existing observe path. No bounded buffer, no retry, no new network surface.

> **Note (Phase 3a does not introduce a new daemon route).** Earlier drafts of this spec proposed a `POST /events/t0` route. That was wrong — the existing `observe()` callback already provides the worker → daemon → `T0Writer` path used for `agent-prompt` and `agent-response` events. CapturePort reuses that path; no new route is added.

### Modified files

#### `packages/core/src/schemas/event.ts`

Add `'agent-thought'` to `EventTypeSchema`:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

This is the only DDL/schema delta in the phase. No migration is required; `event_type` is `TEXT` at the SQLite layer and `t0_events` rows accept any string value — the enum is enforced at the application layer (zod) only.

Any `switch` statements on `EventTypeSchema` in `packages/core/src/writers/t1.ts`, `packages/core/src/writers/t2.ts`, and other consumers must remain exhaustive. A pre-implementation grep for `event_type` and `EventTypeSchema` should identify call sites; each gains an `'agent-thought'` arm. Where the existing handler for `'agent-response'` is appropriate, the new arm can fall through to the same logic.

#### `packages/agentchat/src/adapters/stdio-acp.ts`

The existing `client.on('session/update', ...)` block (around line 322 today) is extended to call `port?.emit(...)` for each handled notification. The dispatch switch already discriminates on `update.sessionUpdate`; we add emit calls without changing the existing tool_use rejection logic.

Sketch:

```ts
client.on('session/update', (params: any) => {
  const update = params?.update;
  if (!update || typeof update !== 'object') return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = update.content;
      if (content?.type === 'text' && typeof content.text === 'string') {
        accumulatedText += content.text;
        this.opts.capturePort?.emit({ kind: 'agent_message_chunk', content: content.text });
      }
      break;
    }
    case 'agent_thought_chunk': {
      const content = update.content;
      if (content?.type === 'text' && typeof content.text === 'string') {
        this.opts.capturePort?.emit({ kind: 'agent_thought_chunk', content: content.text });
      }
      break;
    }
    case 'tool_call': {
      this.opts.capturePort?.emit({
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        status: update.status,
        input: update.input,
      });
      // existing single-turn echo guard logic unchanged
      ...
      break;
    }
    case 'tool_call_update': {
      this.opts.capturePort?.emit({
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.status,
        output: update.output,
      });
      ...
      break;
    }
  }
});
```

The capture port is opt-in via `opts.capturePort`; existing tests that don't pass one continue to work unchanged.

#### `packages/agentchat/src/cli/loop.ts` (modify `runChatTurn`)

The dispatch loop currently calls `await input.observe(...)` for the prompt (line ~40) and the response (line ~93). Those calls remain unchanged.

What is added:

1. Construct a `CapturePort` after the prompt observe and before invoking the adapter, passing the same `input.observe` callback into it along with provenance fields drawn from `input.conversation`, `cfg`, and the handoff context.
2. Pass the port to the adapter via `opts.capturePort` (the adapter is the only consumer that needs it; the port does not need to be visible elsewhere).
3. After the adapter's iterator finishes, call `await port.close()` in a `try/finally` so port shutdown is guaranteed even if the adapter throws.
4. Log `port.getStats()` to stderr at close-time for operational diagnostics.

Notably, the **prompt and response are NOT emitted through CapturePort** — they continue to be observed directly with `await input.observe(...)`. The port is only for mid-turn events (`agent_thought_chunk`, `tool_call`, `tool_call_update`). This preserves the existing semantics where prompt/response failures fail the turn (essential events) and adds best-effort capture for everything else.

#### `packages/core/src/readers/recall.ts`

`RecallReader.recall()` gains two optional fields on its options object:

```ts
recall(opts: {
  q: string;
  /* existing fields */
  session_id?: string;
  event_types?: string[];
}): RecallResult[];
```

Behavior per tier:
- **t0 branch:** the FTS5 query gains `WHERE` clauses for `session_id` (when provided) and `event_type IN (...)` (when provided). Implementation should use parameter binding, not string interpolation.
- **t1 branch:** applies `session_id` if provided (`t1_rollups` has `session_id`). Ignores `event_types` (t1 is a roll-up, not an event type).
- **t2 branch:** ignores both. (`t2_memories` is summary-level; `source_session_ids` is an array column the user can filter via existing surface, not via these new fields.)

RRF fusion logic over the three tier outputs is unchanged.

#### `packages/mcp/src/tools/recall.ts`

Mirror the new fields in the MCP tool's zod input schema and pass them through to `RecallReader`. No semantic change beyond the surface addition.

#### `packages/cli/src/commands/recall.ts`

Add `--session <id>` and `--event-types <comma-list>` flags. Parse, pass through to the same call.

### Files NOT touched

- `T0Writer` — already accepts `T0Event`, no change.
- `t0_events` table or FTS5 indexing — no DDL.
- Daemon routes — **no new route added**; the existing `observe()` host implementation is reused as-is.
- t0 retention worker (`packages/daemon/src/workers/t0-retention.ts`) — existing retention applies; dispatch rows are not special.
- t1 rollup writer — t1 already aggregates from `t0_events` by `session_id`; dispatch rows roll up automatically.
- t2 promotion — reads t1 transcripts; flows through naturally.
- Existing `agent-prompt` / `agent-response` observes in `runChatTurn` — preserved unchanged.

## Data flow

A walkthrough of one dispatch from prompt to recall hit.

### Dispatch entry

`chain_start({ agent: "gemini-acp-pro", prompt: "Refactor X" })` → daemon assigns `chain_id = c-abc123`, `handoff_id = h-xyz789`, enqueues a handoff. A worker picks it up.

### Worker setup (per dispatch)

`runChatTurn` already awaits `input.observe(...)` for the prompt before invoking the adapter (existing behavior, unchanged). The new code wires CapturePort between that observe and the adapter call:

```ts
// existing — prompt observe is awaited and runs before any new code
const promptEvent = await input.observe({ /* agent-prompt event */ });

// new — port reuses the same observe callback for mid-turn events
const port = new CapturePort({
  observe: input.observe,
  chainId: input.conversation.id,        // chain_id (per Q4 mapping)
  handoffId: input.handoff_id,
  projectId: input.conversation.project_id,
  agentName: cfg.name,
  provider: <derived from cfg or null>,
  model: <derived from cfg or null>,
  lane: <derived from cfg; default 'cli-subscription' as runChatTurn already does>,
});

const adapter = buildAdapter(cfg.adapter, { ...cfg.options, capturePort: port });
try {
  for await (const ev of ensureDispatchStream(adapter, dispatchInput)) { /* ... */ }
} finally {
  await port.close();
}

// existing — response observe is awaited after the adapter loop
const responseEvent = await input.observe({ /* agent-response event */ });
```

No worker-synthesized prompt event is needed: `runChatTurn` already produces it.

### ACP turn

`agent_message_chunk` events continue to accumulate into `accumulatedText` for the final `agent-response` observe (existing behavior). The CapturePort observes the *other* mid-turn flavors — thoughts and tool-calls. Example notification sequence:

| ACP notification | Behavior |
|---|---|
| `agent_message_chunk` ("The file") | accumulated into `accumulatedText` (existing); CapturePort sees nothing |
| `agent_thought_chunk` ("Hmm…") | port emits → appends to thought buffer |
| `agent_thought_chunk` (" maybe…") | port emits → appends |
| `tool_call` (`Read("a.ts")`) | port emits → flushes thought buffer (1 `agent-thought` row via `void observe(...)`); held in tool-call Map |
| `agent_message_chunk` ("…is at") | accumulated (existing) |
| `tool_call_update` (status=completed, output=...) | port emits → merges with held start → 1 `agent-tool-use` row via `void observe(...)` |
| `agent_message_chunk` (" line 42.") | accumulated (existing) |
| (turn end — adapter iterator finishes) | `port.close()` flushes any remaining open buffers → emits the orphan-canceled rows if any tool_calls still pending; awaits all in-flight observe promises |
| (then: existing `await input.observe(...)` writes the final `agent-response` row from `accumulatedText`) | |

Per-turn output: 1 `agent-prompt` (existing) + 1 `agent-response` (existing) + 0–N `agent-thought` (new) + 0–N `agent-tool-use` (new). Typically 3–8 t0 rows total. Note that any non-chunk event triggers a flush of the open chunk buffers in the port, so the coalescer preserves interleaving boundaries even when thought streams interleave with tool calls.

### t0 row construction

For each flushed event the port builds an event object passed to `observe()`:

```ts
{
  ts: <iso8601 of the first chunk's arrival, or tool_call start>,
  source: 'agentchat',
  source_detail: <agentName>,
  project_id: <projectId>,
  user_id: 'local-user',                     // matches existing runChatTurn convention
  machine_id: 'local',                       // matches existing runChatTurn convention
  session_id: chainId ?? handoffId,          // Q4 fallback
  event_type: 'agent-thought' | 'agent-tool-use',  // new types only; prompt/response keep their existing flow
  lane: <opts.lane>,
  provider: <opts.provider>,
  model: <opts.model>,
  latency_ms: <coalesced for tool_call; null for thought>,
  payload_json: {
    handoff_id: <handoffId>,
    text?: string,                           // for agent-thought
    tool_call_id?: string,                   // for tool_call rows
    input?: unknown,                         // 8 KB-capped, with truncated flag
    output?: unknown,                        // 8 KB-capped, with truncated flag
    status?: 'completed' | 'failed' | 'canceled',
    lifecycle?: 'orphaned',                  // only when tool_call had no terminal
    truncated?: boolean,
    bytes_total?: number,
  },
  payload_summary: <first 240 chars of text or constructed tool_call summary>,
}
```

The exact schema accepted by `observe()` is whatever the existing callback already accepts (it carries fields beyond strict `T0EventInputSchema` — note `triggered_by_event_id` at `loop.ts:104`). Implementation should grep the observe callback definition before finalizing the field list and mirror exactly.

### Daemon write

The event flows through the existing `observe()` host implementation — the same path that handles `agent-prompt` and `agent-response` today. No daemon-side changes in Phase 3a.

### Recall

A user later calls `memory.recall({ q: "how did we refactor X" })` — or, with the new filters, `memory.recall({ q: "...", session_id: "c-abc123", event_types: ["agent-thought","agent-response"] })`.

`RecallReader` fans out to the t0/t1/t2 query branches. The t0 branch's FTS5 query gains the optional `WHERE` clauses; the other tiers apply or ignore the filters as described in the components section. RRF fusion runs across the three lists as it does today.

The user gets ranked hits including the agent's actual reasoning trail.

## Error handling

The error surface is small because the port reuses the existing `observe()` callback rather than implementing its own network primitive.

1. **`observe()` rejects (any reason — daemon slow, daemon down, DB error, validation failure).** The promise's `.catch()` increments `failed`, logs `capture-port: observe failed: <error>` to stderr, and discards the event. **No retry.** The dispatch turn is unaffected because the port called `void observe(...)` — it never awaited the promise. This is the load-bearing semantic difference from the existing `await input.observe(...)` calls for prompt/response: those are essential to a coherent turn record and intentionally fail the turn on error; mid-turn CoT is observability and is best-effort.
2. **Worker crash mid-turn.** In-memory coalescer state lost. Already-resolved observe calls are durable. Same posture as any other in-flight worker work; outside the scope of capture.
3. **Tool_call without a matching terminal.** The worker buffered a `tool_call` start with no terminal `tool_call_update` arriving (e.g. agent CLI crashes mid-tool-call). `port.close()` walks the open-tool-call Map and emits each as a `'canceled'` row with `payload_json.lifecycle: 'orphaned'` and a derived `latency_ms`. This prevents silent truncation of the recall surface.
4. **Adapter throws (existing dispatch failure path).** The `try/finally` in `runChatTurn` ensures `port.close()` runs, draining open buffers and awaiting outstanding promises before propagating the error. Any post-close `emit()` calls become no-ops.

By design, **no failure path in `CapturePort` propagates to the dispatch turn outcome**. The port exposes `getStats()` returning `{ sent, failed }`; the worker logs these at `close()` time so under-recall in production is diagnosable from worker stderr.

What we deliberately do **not** add:
- Retry/backoff logic. If `observe()` reliability ever becomes a problem, that is a fix to the observe host (which would also benefit prompt/response capture), not a layer in CapturePort.
- A bounded send buffer. The natural bound is the number of mid-turn events per turn — small, well-understood, and not at risk of unbounded growth.
- A WAL-on-disk journal. Rejected during brainstorming as too heavy for a recall-fidelity feature.

## Testing

### Unit — `packages/agentchat/test/worker/capture-port.test.ts` (new, ~9 tests)

Pure tests over the port using a fake `observe` callback (records its calls):

| # | Test | Verifies |
|---|---|---|
| 1 | Single thought chunk → close → one observe call with `event_type: 'agent-thought'` and matching `text` | basic happy path |
| 2 | N thought chunks → close → one coalesced observe call with concatenated text | per-kind chunk coalescing |
| 3 | thought chunks interleaved with a tool_call → flush boundaries respected → thought row written before tool_call row | non-chunk-triggered flush boundaries |
| 4 | `tool_call` start + `tool_call_update` completed (same `toolCallId`) → one observe call with merged input/output and `latency_ms > 0` | tool_call lifecycle merge |
| 5 | `tool_call` start with no terminal → close → one observe call with `status: 'canceled'`, `payload_json.lifecycle: 'orphaned'` | orphan handling |
| 6 | input/output > 8 KB → observe call has truncated values + `truncated: true` + `bytes_total: N` | truncation |
| 7 | `chainId: null` → observed `session_id === handoffId` | session_id fallback |
| 8 | observe rejects on one event, others succeed → `failed === 1`, port does not throw, `close()` resolves cleanly | best-effort failure semantics |
| 9 | `close()` awaits all in-flight observe promises before resolving | shutdown determinism |

### Unit — `packages/core/test/readers/recall.test.ts` (extend, ~3 new tests)

- `recall({ session_id })` returns only t0/t1 rows matching that session.
- `recall({ event_types: ['agent-thought'] })` returns only those t0 rows; t2 hits unaffected.
- `recall({ session_id, event_types })` combines both filters.

### Integration — `packages/e2e/test/smoke/dispatch-t0-capture.test.ts` (new, 1 test)

End-to-end smoke through the live daemon + a deterministic mock ACP CLI:

1. Spin up a fresh daemon under a temp storage root.
2. Register a deterministic mock ACP CLI: a small bun script that, on `session/prompt`, emits a known sequence of `agent_message_chunk`, `agent_thought_chunk`, and one `tool_call`/`tool_call_update` pair, then ends the turn with `stopReason: 'end_turn'`.
3. `chain_start({ agent: 'mock-acp', prompt: 'test' })` → `chain_wait` for completion.
4. Query t0 directly: `SELECT event_type, payload_summary FROM t0_events WHERE session_id = ? ORDER BY ts ASC`.
5. Assert the row set for the chain's `session_id`:
   - exactly one `agent-prompt` (already written by `runChatTurn` today),
   - exactly one `agent-response` (already written today),
   - exactly one `agent-thought` (new, via CapturePort),
   - exactly one `agent-tool-use` (new, via CapturePort),
   - in non-decreasing `ts` order with prompt first and response last.
6. Call `memory.recall({ q: '<known phrase from the mock>', session_id: '<chain_id>' })` and assert at least one t0 hit returns with the expected text.

This is the load-bearing test — proves the full pipeline (port → observe → t0 → recall) and confirms that the new event types coexist with the existing prompt/response capture.

### Out of scope

- t1 rollup behavior under dispatch event volume — Wave 5 already covers t1 retrieval; a stress test belongs in a separate phase if it ever becomes a concern.
- Real ACP CLI agents (`gemini`, `codex`, etc.) — covered by existing dispatch smoke tests; this phase doesn't re-exercise them in CI.
- Daemon shutdown mid-flush — process-lifecycle test; out of scope.
- Concurrent dispatches contending on the existing `observe()` host implementation — already exercised by today's prompt/response capture; we trust it.

### Manual verification (one-time, post-landing)

After Phase 3a lands and a fresh worker rolls with the new code:

- `chain_start` a real dispatch → `chain_wait` → `memory.recall(<a phrase from the response>)` returns the t0 hit.
- One-shot probe: `sqlite3 <storage-root>/penumbra.db "SELECT event_type, COUNT(*) FROM t0_events WHERE source='agentchat' GROUP BY event_type"` shows non-zero counts across `agent-prompt`, `agent-response`, `agent-thought` (where the agent emits thoughts), `agent-tool-use`.
- Worker stderr at dispatch end shows `capture-port stats: sent=N failed=0`.

Note: the sqlite probe is a one-time verification, not the operational pattern. (`Use penumbra MCP tools — never query the live sqlite DB directly` remains the standing rule.)

## Risk Register

- **Switch-statement exhaustiveness drift.** Adding `'agent-thought'` to `EventTypeSchema` requires updating any `switch (event_type)` blocks in `packages/core/src/writers/t1.ts`, `packages/core/src/writers/t2.ts`, and any other consumers. Mitigation: pre-implementation grep for `EventTypeSchema` and `event_type` to enumerate sites; each gets an explicit arm (most can fall through to the existing `'agent-response'` handler).
- **Coalescer correctness.** The chunk-flush-on-non-chunk-event rule is the trickiest part of the port. Test #3 (interleaved thought / tool_call streams) is specifically designed to catch off-by-one or missed-flush bugs. The coalescer state is pure data structures (no async) so it is directly testable.
- **`observe()` callback shape.** The existing `runChatTurn` calls `observe()` with fields beyond strict `T0EventInputSchema` (notably `triggered_by_event_id`). The implementation plan must grep the observe callback definition before finalizing the field list and mirror what the host actually accepts, rather than relying on the static T0EventInput type.
- **Recall surface change is not backward-incompatible** — `session_id` and `event_types` are optional, default behavior unchanged. No callers break.
- **Volume of t0 rows under heavy parallel dispatch.** With per-message coalescing the volume is bounded (~5–15 rows/turn including the existing prompt/response). At our typical concurrency (~4 workers), peak volume is well within sqlite's write capacity through the existing observe path.
- **`payload_json.handoff_id` redundancy.** We store `handoff_id` in `payload_json.handoff_id` even though the existing observe shape may also carry it elsewhere. The duplication is intentional: it keeps the FTS surface self-contained so recall display does not need to re-join on a separate column. Cost: ~36 bytes per row. Acceptable.

## Implementation Sequence (rough)

A detailed implementation plan will be produced by the writing-plans skill after this spec is approved. The rough commit order:

1. Schema delta: add `'agent-thought'` to `EventTypeSchema`; update exhaustive switches; update tests. (Cheap, isolated, lands first to unblock everything else.)
2. New `CapturePort` module + unit tests.
3. Wire `CapturePort` into `stdio-acp.ts` and `runChatTurn` (`packages/agentchat/src/cli/loop.ts`).
4. Extend `RecallReader.recall()` with `session_id` + `event_types` filters; mirror in MCP tool and CLI.
5. Integration smoke test (`dispatch-t0-capture.test.ts`).

## Future Work (Out of Scope)

- New replay tool: `chain_get_cot(chain_id)` returning all t0 events for a chain in order, distinct from RRF-based recall. Matches the existing `chain_get_messages` MCP shape and would pair naturally with it.
- SDK-adapter capture (`packages/agentchat/src/sdk/adapter.ts`): wire the existing SDK adapter to emit through the same `CapturePort`. No daemon-side change needed.
- Field-level filters on recall (`provider`, `model`, `agent_name`) — useful if the routing-data work in Phase 3d ships.
- Backfill of older dispatches from any persisted artifacts (handoff transcripts, etc.) — only valuable if a real query motivates it.
