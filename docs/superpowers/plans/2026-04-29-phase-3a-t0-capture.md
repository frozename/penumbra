# Phase 3a — Dispatch t0 Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist ACP `session/update` notifications (agent thoughts and tool-call lifecycle) from dispatched agent turns as `t0_events`, and extend `memory.recall` with `session_id` and `event_types` filters so chain-of-thought becomes a first-class recall surface.

**Architecture:** A new worker-process `CapturePort` coalesces chunk streams (per kind) and merges tool_call lifecycles (start args + terminal output → one row), then emits via the **existing** `observe()` callback that `runChatTurn` already uses for prompt/response events — no new daemon route. Mid-turn capture is non-blocking (`void observe(...)`) so capture failures never propagate to the dispatch turn outcome.

**Tech Stack:** Bun, TypeScript, SQLite (with FTS5 + sqlite-vec), zod, ACP (Agent Client Protocol).

**Spec:** [`docs/superpowers/specs/2026-04-29-phase-3a-t0-capture-design.md`](../specs/2026-04-29-phase-3a-t0-capture-design.md)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/core/src/schemas/event.ts` | modify | Add `'agent-thought'` to `EventTypeSchema`. |
| `packages/core/test/schemas/event.test.ts` | extend | Round-trip parse the new value. |
| `packages/core/src/schemas/recall.ts` | modify | Add optional `session_id`, `event_types` to `RecallRequest`. |
| `packages/core/src/readers/recall.ts` | modify | `queryT0` accepts `session_id`/`event_types`; `RecallReader.recall` plumbs them through. |
| `packages/core/test/readers/recall-t0.test.ts` | extend | New filter cases. |
| `packages/agentchat/src/worker/capture-port.ts` | new | Coalescer + non-blocking emit through `observe()`. |
| `packages/agentchat/test/worker/capture-port.test.ts` | new | 9 unit tests for the port. |
| `packages/agentchat/src/adapters/stdio-acp.ts` | modify | Call `port?.emit(...)` from the existing `session/update` handler; accept `capturePort` opt. |
| `packages/agentchat/src/cli/loop.ts` | modify | Construct `CapturePort` between prompt observe and adapter; close in `finally`. |
| `packages/mcp/src/tools/recall.ts` | modify | Mirror new fields in MCP zod schema. |
| `packages/cli/src/commands/recall.ts` | modify | Add `--session`, `--event-types` flags. |
| `packages/e2e/test/smoke/fixtures/mock-acp-cli.ts` | new | Deterministic ACP CLI for the smoke test. |
| `packages/e2e/test/smoke/dispatch-t0-capture.test.ts` | new | End-to-end smoke: dispatch → t0 → recall. |

**Files not touched:** `T0Writer`, `t0_events` table/FTS5 schema, daemon routes, t0-retention worker, t1/t2 writers (they auto-handle the new event types via existing fall-through), the existing `agent-prompt` / `agent-response` observes in `runChatTurn`.

---

## Task 1: Schema delta — add `'agent-thought'` to `EventTypeSchema`

**Files:**
- Modify: `packages/core/src/schemas/event.ts:6-12`
- Test: `packages/core/test/schemas/event.test.ts`

This is the foundational change. Land first so nothing else has to wait on enum widening.

- [ ] **Step 1: Find existing event-schema test (if any) and pick the test file**

```bash
ls packages/core/test/schemas/
```

If `event.test.ts` exists, extend it. If not, create it. The rest of this task assumes you create it; adapt if you found one.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/schemas/event.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { EventTypeSchema, T0EventInputSchema } from '../../src/schemas/event.js';

test('EventTypeSchema accepts agent-thought', () => {
  expect(EventTypeSchema.parse('agent-thought')).toBe('agent-thought');
});

test('T0EventInputSchema accepts an agent-thought event', () => {
  const parsed = T0EventInputSchema.parse({
    ts: '2026-04-29T00:00:00Z',
    source: 'agentchat',
    user_id: 'u',
    machine_id: 'm',
    event_type: 'agent-thought',
    lane: 'cloud',
    payload_json: { text: 'thinking…' },
  });
  expect(parsed.event_type).toBe('agent-thought');
});
```

- [ ] **Step 3: Run the test and verify it fails**

```bash
bun test packages/core/test/schemas/event.test.ts
```

Expected: FAIL on `EventTypeSchema.parse('agent-thought')` with a zod invalid-enum-value error.

- [ ] **Step 4: Add `'agent-thought'` to the enum**

In `packages/core/src/schemas/event.ts`, line 6-12, change:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

to:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
bun test packages/core/test/schemas/event.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 6: Run full typecheck to confirm no consumers break**

```bash
bun run typecheck
```

Expected: 0 errors. If any consumer broke (a switch statement that needed updating), add a fall-through arm to whatever the existing `'agent-response'` handler does, then re-run typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts
git commit -m "feat(core): add agent-thought event_type for dispatch CoT capture"
```

---

## Task 2: `CapturePort` module + unit tests

**Files:**
- Create: `packages/agentchat/src/worker/capture-port.ts`
- Create: `packages/agentchat/test/worker/capture-port.test.ts`

The port encapsulates coalescing logic and emits via a passed-in `observe()` callback. Pure data structures + a non-blocking emit pattern. No daemon-side dependencies — all 9 tests use a fake `observe`.

- [ ] **Step 1: Write the test file with all 9 cases (failing — module doesn't exist yet)**

Create `packages/agentchat/test/worker/capture-port.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { CapturePort, type NotificationEvent } from '../../src/worker/capture-port.js';

type Recorded = { args: any; resolve: (v: { event_id: string }) => void; reject: (e: Error) => void };

function makeFakeObserve() {
  const calls: any[] = [];
  let pending: Recorded[] = [];
  const observe = (event: any): Promise<{ event_id: string }> => {
    calls.push(event);
    return new Promise<{ event_id: string }>((resolve, reject) => {
      pending.push({ args: event, resolve, reject });
    });
  };
  const resolveAll = () => {
    const p = pending; pending = [];
    for (const c of p) c.resolve({ event_id: `ev-${Math.random().toString(36).slice(2, 8)}` });
  };
  const rejectNext = (err: Error) => {
    const c = pending.shift(); if (c) c.reject(err);
  };
  return { observe, calls, resolveAll, rejectNext };
}

const baseOpts = {
  chainId: 'c-abc',
  handoffId: 'h-xyz',
  projectId: 'p-1',
  agentName: 'mock-agent',
  provider: 'mock',
  model: 'mock-1',
  lane: 'cloud' as const,
};

test('1. single thought chunk → close → one observe call (agent-thought)', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'agent_thought_chunk', content: 'hello' });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].event_type).toBe('agent-thought');
  expect(f.calls[0].payload_json.text).toBe('hello');
  expect(f.calls[0].session_id).toBe('c-abc');
});

test('2. N thought chunks → one coalesced observe call', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  for (const c of ['a', 'b', 'c', 'd']) port.emit({ kind: 'agent_thought_chunk', content: c });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].payload_json.text).toBe('abcd');
});

test('3. thought chunks then a tool_call → flush boundaries respected', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'agent_thought_chunk', content: 'thinking' });
  port.emit({ kind: 'tool_call', toolCallId: 'tc-1', status: 'pending', input: { x: 1 } });
  port.emit({ kind: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', output: { y: 2 } });
  const closing = port.close();
  f.resolveAll();
  await closing;
  // 1 thought row + 1 tool_call row, in that order
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].event_type).toBe('agent-thought');
  expect(f.calls[1].event_type).toBe('agent-tool-use');
});

test('4. tool_call start + terminal update → merged row with latency_ms', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'tool_call', toolCallId: 'tc-1', status: 'pending', input: { path: 'a.ts' } });
  // Force a small wall-clock gap so latency_ms > 0.
  await new Promise((r) => setTimeout(r, 5));
  port.emit({ kind: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', output: { ok: true } });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  const r = f.calls[0];
  expect(r.event_type).toBe('agent-tool-use');
  expect(r.payload_json.input).toEqual({ path: 'a.ts' });
  expect(r.payload_json.output).toEqual({ ok: true });
  expect(r.payload_json.status).toBe('completed');
  expect(typeof r.latency_ms).toBe('number');
  expect(r.latency_ms).toBeGreaterThan(0);
});

test('5. tool_call start with no terminal → orphan row on close', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'tool_call', toolCallId: 'tc-orphan', status: 'pending', input: { x: 1 } });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  const r = f.calls[0];
  expect(r.event_type).toBe('agent-tool-use');
  expect(r.payload_json.status).toBe('canceled');
  expect(r.payload_json.lifecycle).toBe('orphaned');
  expect(r.payload_json.output).toBeNull();
});

test('6. >8 KB input/output → truncated with bytes_total', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  const big = 'x'.repeat(20_000);
  port.emit({ kind: 'tool_call', toolCallId: 'tc-big', status: 'pending', input: { blob: big } });
  port.emit({ kind: 'tool_call_update', toolCallId: 'tc-big', status: 'completed', output: { blob: big } });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const r = f.calls[0];
  expect(r.payload_json.truncated).toBe(true);
  expect(r.payload_json.bytes_total).toBeGreaterThan(8 * 1024);
  // Truncated value should be <=8KB after JSON re-serialize
  expect(JSON.stringify(r.payload_json.input).length).toBeLessThanOrEqual(8 * 1024 + 256); // small slack for wrapping
});

test('7. chainId=null → session_id falls back to handoffId', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, chainId: null, observe: f.observe });
  port.emit({ kind: 'agent_thought_chunk', content: 'x' });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls[0].session_id).toBe('h-xyz');
});

test('8. observe rejection on one event → port records failure, does not throw', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'agent_thought_chunk', content: 'a' });
  port.emit({ kind: 'tool_call', toolCallId: 't', status: 'pending', input: {} });
  port.emit({ kind: 'tool_call_update', toolCallId: 't', status: 'completed', output: {} });
  // First in-flight = thought, second = tool_call merged. Reject the first; resolve the rest.
  f.rejectNext(new Error('observe down'));
  f.resolveAll();
  const closing = port.close();
  // Anything queued during close also resolves
  f.resolveAll();
  await closing;
  const stats = port.getStats();
  expect(stats.failed).toBeGreaterThanOrEqual(1);
  expect(stats.sent).toBeGreaterThanOrEqual(1);
});

test('9. close() awaits in-flight observe promises', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'agent_thought_chunk', content: 'x' });
  let closeResolved = false;
  const closing = port.close().then(() => { closeResolved = true; });
  // close should not have resolved while observe is still pending
  await new Promise((r) => setTimeout(r, 10));
  expect(closeResolved).toBe(false);
  f.resolveAll();
  await closing;
  expect(closeResolved).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail (module missing)**

```bash
bun test packages/agentchat/test/worker/capture-port.test.ts
```

Expected: FAIL on `Cannot find module '../../src/worker/capture-port.js'`.

- [ ] **Step 3: Implement `CapturePort`**

Create `packages/agentchat/src/worker/capture-port.ts`:

```ts
/**
 * CapturePort
 *
 * Coalesces ACP session/update notifications into a small set of t0 events
 * and emits them through the worker-supplied `observe()` callback (the same
 * callback runChatTurn uses for agent-prompt / agent-response).
 *
 * Capture is best-effort and non-blocking: emit() never throws, and observe()
 * is called via `void` (a rejection only logs and increments a counter).
 */

const PAYLOAD_FIELD_BYTE_LIMIT = 8 * 1024;

export interface CapturePortOpts {
  observe: (event: any) => Promise<{ event_id: string }>;
  chainId: string | null;
  handoffId: string;
  projectId: string | null;
  agentName: string;
  provider: string | null;
  model: string | null;
  lane: 'local' | 'cloud' | 'cli-subscription' | 'unknown';
  /** Optional: parent event id (e.g. the prompt event) to stamp as triggered_by_event_id. */
  triggeredByEventId?: string | null;
}

export interface NotificationEvent {
  kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update';
  toolCallId?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
  content?: string;
  input?: unknown;
  output?: unknown;
}

interface ChunkBuffer {
  kind: 'agent_message_chunk' | 'agent_thought_chunk';
  text: string;
  startedAt: number;
}

interface PendingToolCall {
  toolCallId: string;
  startedAt: number;
  input: unknown;
}

export class CapturePort {
  private readonly opts: CapturePortOpts;
  private chunkBuffer: ChunkBuffer | null = null;
  private readonly pendingTools = new Map<string, PendingToolCall>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;
  private stats = { sent: 0, failed: 0 };

  constructor(opts: CapturePortOpts) {
    this.opts = opts;
  }

  emit(ev: NotificationEvent): void {
    if (this.closed) return;
    if (ev.kind === 'agent_message_chunk' || ev.kind === 'agent_thought_chunk') {
      // Flush any open buffer of a different kind first.
      if (this.chunkBuffer && this.chunkBuffer.kind !== ev.kind) {
        this.flushChunkBuffer();
      }
      if (!this.chunkBuffer) {
        this.chunkBuffer = { kind: ev.kind, text: '', startedAt: Date.now() };
      }
      this.chunkBuffer.text += ev.content ?? '';
      return;
    }
    // Non-chunk event: flush any open chunk buffer first, then handle.
    if (this.chunkBuffer) this.flushChunkBuffer();
    if (ev.kind === 'tool_call' && ev.toolCallId) {
      this.pendingTools.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        startedAt: Date.now(),
        input: ev.input ?? null,
      });
      return;
    }
    if (ev.kind === 'tool_call_update' && ev.toolCallId) {
      const isTerminal =
        ev.status === 'completed' || ev.status === 'failed' || ev.status === 'canceled';
      if (!isTerminal) return;
      const start = this.pendingTools.get(ev.toolCallId);
      this.pendingTools.delete(ev.toolCallId);
      this.emitToolCallRow({
        toolCallId: ev.toolCallId,
        startedAt: start?.startedAt ?? Date.now(),
        input: start?.input ?? null,
        output: ev.output ?? null,
        status: ev.status as 'completed' | 'failed' | 'canceled',
        lifecycle: null,
      });
      return;
    }
  }

  async flush(): Promise<void> {
    if (this.chunkBuffer) this.flushChunkBuffer();
    // Orphan any pending tool_calls.
    for (const tc of this.pendingTools.values()) {
      this.emitToolCallRow({
        toolCallId: tc.toolCallId,
        startedAt: tc.startedAt,
        input: tc.input,
        output: null,
        status: 'canceled',
        lifecycle: 'orphaned',
      });
    }
    this.pendingTools.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  getStats(): { sent: number; failed: number } {
    return { ...this.stats };
  }

  private flushChunkBuffer(): void {
    const buf = this.chunkBuffer;
    if (!buf) return;
    this.chunkBuffer = null;
    const eventType = buf.kind === 'agent_message_chunk' ? 'agent-response' : 'agent-thought';
    const text = buf.text;
    const startedAt = buf.startedAt;
    const ts = new Date(startedAt).toISOString();
    const summary = text.slice(0, 240);
    const event = {
      ts,
      source: 'agentchat' as const,
      source_detail: this.opts.agentName,
      project_id: this.opts.projectId,
      user_id: 'local-user',
      machine_id: 'local',
      session_id: this.opts.chainId ?? this.opts.handoffId,
      event_type: eventType,
      lane: this.opts.lane,
      provider: this.opts.provider,
      model: this.opts.model,
      latency_ms: Date.now() - startedAt,
      payload_json: { handoff_id: this.opts.handoffId, text },
      payload_summary: summary,
      ...(this.opts.triggeredByEventId
        ? { triggered_by_event_id: this.opts.triggeredByEventId }
        : {}),
    };
    this.dispatch(event);
  }

  private emitToolCallRow(args: {
    toolCallId: string;
    startedAt: number;
    input: unknown;
    output: unknown;
    status: 'completed' | 'failed' | 'canceled';
    lifecycle: 'orphaned' | null;
  }): void {
    const ts = new Date(args.startedAt).toISOString();
    const truncatedIn = clampField(args.input);
    const truncatedOut = clampField(args.output);
    const anyTruncated = truncatedIn.truncated || truncatedOut.truncated;
    const bytesTotal = truncatedIn.truncated || truncatedOut.truncated
      ? truncatedIn.bytesTotal + truncatedOut.bytesTotal
      : undefined;
    const summary = `${args.toolCallId} ${args.status}`.slice(0, 240);
    const event = {
      ts,
      source: 'agentchat' as const,
      source_detail: this.opts.agentName,
      project_id: this.opts.projectId,
      user_id: 'local-user',
      machine_id: 'local',
      session_id: this.opts.chainId ?? this.opts.handoffId,
      event_type: 'agent-tool-use',
      lane: this.opts.lane,
      provider: this.opts.provider,
      model: this.opts.model,
      latency_ms: Date.now() - args.startedAt,
      payload_json: {
        handoff_id: this.opts.handoffId,
        tool_call_id: args.toolCallId,
        input: truncatedIn.value,
        output: truncatedOut.value,
        status: args.status,
        ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
        ...(anyTruncated ? { truncated: true, bytes_total: bytesTotal } : {}),
      },
      payload_summary: summary,
      ...(this.opts.triggeredByEventId
        ? { triggered_by_event_id: this.opts.triggeredByEventId }
        : {}),
    };
    this.dispatch(event);
  }

  private dispatch(event: any): void {
    const p = this.opts
      .observe(event)
      .then(() => {
        this.stats.sent += 1;
      })
      .catch((err: unknown) => {
        this.stats.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`capture-port: observe failed: ${msg}`);
      })
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }
}

function clampField(value: unknown): { value: unknown; truncated: boolean; bytesTotal: number } {
  if (value === null || value === undefined) return { value, truncated: false, bytesTotal: 0 };
  const json = JSON.stringify(value);
  const bytesTotal = Buffer.byteLength(json, 'utf8');
  if (bytesTotal <= PAYLOAD_FIELD_BYTE_LIMIT) {
    return { value, truncated: false, bytesTotal };
  }
  const truncated = json.slice(0, PAYLOAD_FIELD_BYTE_LIMIT);
  return { value: { __truncated_string: truncated }, truncated: true, bytesTotal };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
bun test packages/agentchat/test/worker/capture-port.test.ts
```

Expected: 9 PASS, 0 FAIL. If test 6 fails on the byte-size assertion, the truncation strategy may need adjusting — verify that `JSON.stringify(r.payload_json.input).length` is bounded.

- [ ] **Step 5: Run the full agentchat test suite to confirm no regressions**

```bash
bun test packages/agentchat
```

Expected: all pass.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/worker/capture-port.ts packages/agentchat/test/worker/capture-port.test.ts
git commit -m "feat(agentchat): CapturePort coalesces dispatch CoT into t0 events"
```

---

## Task 3: Wire `CapturePort` into `stdio-acp.ts`

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts` (around line 322 — the existing `client.on('session/update', ...)` handler)
- Possibly modify: existing stdio-acp tests if they assert on opts shape

The adapter accepts an optional `capturePort` opt and emits to it from the existing handler. No behavior change when the port is not provided.

- [ ] **Step 1: Read the existing adapter file to find the opts type and the session/update handler**

```bash
grep -n "interface StdioAcpAdapterOpts\|opts:.*StdioAcpAdapter\|session/update" packages/agentchat/src/adapters/stdio-acp.ts | head -10
```

Note the opts interface name (it might be `StdioAcpAdapterOpts` or similar) and the handler block starting around line 322.

- [ ] **Step 2: Write a test for emit-on-session-update**

If `packages/agentchat/test/adapters/stdio-acp.test.ts` exists, extend it. Otherwise create it. The test stubs the ACP client transport with a fake that synthesizes session/update notifications; assert that the supplied capturePort receives matching `emit()` calls.

If the existing test infrastructure makes a unit test for stdio-acp impractical, the integration smoke test in Task 7 covers this end-to-end. In that case, **skip this step** and rely on Task 7. Add a one-line comment in the modified file explaining the test gap.

- [ ] **Step 3: Add `capturePort` to the adapter's opts type**

In `packages/agentchat/src/adapters/stdio-acp.ts`, find the opts interface (e.g. `interface StdioAcpAdapterOpts`) and add:

```ts
import type { CapturePort } from '../worker/capture-port.js';

// inside the opts interface:
capturePort?: CapturePort;
```

- [ ] **Step 4: Wire `port?.emit(...)` into the existing session/update handler**

In the existing `client.on('session/update', ...)` block (around line 322), update each case to also notify the port. The shape:

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
      // existing single-turn echo guard logic — preserve as-is
      if (!this.opts.fsReadTextFile && !this.opts.fsWriteTextFile && !this.opts.terminal) {
        server?.kill();
        toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
      }
      break;
    }
    case 'tool_call_update': {
      this.opts.capturePort?.emit({
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.status,
        output: update.output,
      });
      // existing single-turn echo guard (mirror the tool_call arm) — preserve as-is
      if (!this.opts.fsReadTextFile && !this.opts.fsWriteTextFile && !this.opts.terminal) {
        server?.kill();
        toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
      }
      break;
    }
  }
});
```

**Important:** preserve the existing tool_use rejection logic exactly. The new `agent_thought_chunk` case is *additive* and must not alter the single-turn echo guard — it only emits to the port.

- [ ] **Step 5: Run the agentchat test suite**

```bash
bun test packages/agentchat
```

Expected: all existing tests still pass (the capturePort opt is optional and absent in existing call sites).

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts
# also add the test file if you created one in step 2
git commit -m "feat(agentchat): stdio-acp adapter emits dispatch events to CapturePort"
```

---

## Task 4: Wire `CapturePort` into `runChatTurn`

**Files:**
- Modify: `packages/agentchat/src/cli/loop.ts:35-105` (around the `runChatTurn` function body)

`runChatTurn` constructs a `CapturePort` between the prompt observe and the adapter invocation, passes it to the adapter via `cfg.options.capturePort`, and closes it in a `finally` block.

- [ ] **Step 1: Read the current `runChatTurn` body**

```bash
sed -n '35,110p' packages/agentchat/src/cli/loop.ts
```

Note exact line numbers for the prompt observe call and the adapter dispatch loop — they may have drifted from the spec's reference points.

- [ ] **Step 2: Add the imports and construct the port**

In `packages/agentchat/src/cli/loop.ts`, add at the top:

```ts
import { CapturePort } from '../worker/capture-port.js';
```

After the existing prompt observe (around line 51) and before `const adapter = buildAdapter(...)` (around line 53), insert:

```ts
  const lane = (cfg.lane as 'local' | 'cloud' | 'cli-subscription' | 'unknown' | undefined) ?? 'cli-subscription';
  const port = new CapturePort({
    observe: input.observe,
    chainId: input.conversation.id,
    handoffId: input.handoff_id,
    projectId: input.conversation.project_id,
    agentName: cfg.name,
    provider: (cfg.options as { provider?: string } | undefined)?.provider ?? null,
    model: (cfg.options as { model?: string } | undefined)?.model ?? null,
    lane,
    triggeredByEventId: promptEvent.event_id,
  });
```

(The provider/model derivation is best-effort — not all adapter configs surface these fields; passing `null` is acceptable and matches the schema.)

- [ ] **Step 3: Pass the port to the adapter and close it in a `finally`**

Wrap the adapter invocation. Replace the existing block:

```ts
const adapter = buildAdapter(cfg.adapter, cfg.options);

let outText = '';
let outMeta: DispatchOutput['meta'];
let dispatchError: { message: string } | undefined;
try {
  const dispatchInput = { /* ... */ };
  for await (const ev of ensureDispatchStream(adapter, dispatchInput)) {
    /* ... existing body ... */
  }
} catch (err) {
  dispatchError = { message: err instanceof Error ? err.message : String(err) };
}
```

with:

```ts
const adapter = buildAdapter(cfg.adapter, { ...cfg.options, capturePort: port });

let outText = '';
let outMeta: DispatchOutput['meta'];
let dispatchError: { message: string } | undefined;
try {
  try {
    const dispatchInput = { /* ... existing body ... */ };
    for await (const ev of ensureDispatchStream(adapter, dispatchInput)) {
      /* ... existing body ... */
    }
  } catch (err) {
    dispatchError = { message: err instanceof Error ? err.message : String(err) };
  }
} finally {
  await port.close();
  // eslint-disable-next-line no-console
  console.error(`capture-port stats: sent=${port.getStats().sent} failed=${port.getStats().failed}`);
}
```

(The double-try is intentional: the inner try preserves the existing dispatch-error capture; the outer try/finally guarantees `port.close()` runs.)

- [ ] **Step 4: Run the agentchat suite**

```bash
bun test packages/agentchat
```

Expected: all existing tests pass. If a test stubs `buildAdapter` with a strict opts type, you may need to update the stub to accept the extra `capturePort` field.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/cli/loop.ts
git commit -m "feat(agentchat): runChatTurn wires CapturePort across dispatch turn"
```

---

## Task 5: Extend `RecallRequest` schema + `RecallReader.queryT0`

**Files:**
- Modify: `packages/core/src/schemas/recall.ts`
- Modify: `packages/core/src/readers/recall.ts` (`queryT0` and the `recall` method)
- Test: `packages/core/test/readers/recall-t0.test.ts`

The recall surface gains optional `session_id` and `event_types` filters that flow into the t0 FTS query. t1 honors `session_id`. t2 ignores both.

- [ ] **Step 1: Read the existing RecallRequest schema and queryT0 signature**

```bash
sed -n '1,80p' packages/core/src/schemas/recall.ts
sed -n '180,240p' packages/core/src/readers/recall.ts
```

- [ ] **Step 2: Write failing tests for the new filters**

Extend `packages/core/test/readers/recall-t0.test.ts` with three new tests. The exact insert SQL should match what already exists in the file — adapt the helper if the existing pattern differs:

```ts
test('queryT0 filters by session_id when provided', async () => {
  // Seed two t0 rows with different session_ids and same matching text.
  insertT0Event({
    event_id: 'e1', session_id: 's-abc', event_type: 'agent-thought',
    payload_json: { text: 'refactor the parser' },
  });
  insertT0Event({
    event_id: 'e2', session_id: 's-xyz', event_type: 'agent-thought',
    payload_json: { text: 'refactor the parser' },
  });
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'refactor parser',
    project_id: null,
    limit: 10,
    include_raw: true,
    min_score: 0,
    session_id: 's-abc',
  });
  const ids = results.map((r) => r.id);
  expect(ids).toContain('e1');
  expect(ids).not.toContain('e2');
});

test('queryT0 filters by event_types when provided', async () => {
  insertT0Event({
    event_id: 'e1', session_id: 's', event_type: 'agent-thought',
    payload_json: { text: 'searchable phrase' },
  });
  insertT0Event({
    event_id: 'e2', session_id: 's', event_type: 'agent-response',
    payload_json: { text: 'searchable phrase' },
  });
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'searchable phrase',
    project_id: null,
    limit: 10,
    include_raw: true,
    min_score: 0,
    event_types: ['agent-thought'],
  });
  const ids = results.map((r) => r.id);
  expect(ids).toContain('e1');
  expect(ids).not.toContain('e2');
});

test('queryT0 combines session_id and event_types filters', async () => {
  insertT0Event({
    event_id: 'e-keep', session_id: 's-abc', event_type: 'agent-thought',
    payload_json: { text: 'apple' },
  });
  insertT0Event({
    event_id: 'e-wrong-session', session_id: 's-xyz', event_type: 'agent-thought',
    payload_json: { text: 'apple' },
  });
  insertT0Event({
    event_id: 'e-wrong-type', session_id: 's-abc', event_type: 'agent-response',
    payload_json: { text: 'apple' },
  });
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'apple',
    project_id: null,
    limit: 10,
    include_raw: true,
    min_score: 0,
    session_id: 's-abc',
    event_types: ['agent-thought'],
  });
  const ids = results.map((r) => r.id);
  expect(ids).toEqual(['e-keep']);
});
```

If the existing `recall-t0.test.ts` has its own seeding helper, reuse it; otherwise add an `insertT0Event` helper that mirrors the existing seed pattern (refer to the top of `recall.test.ts` or any other recall test for the canonical insert shape). The helper must include the FTS5 trigger insertion automatically since the schema's trigger handles it.

- [ ] **Step 3: Run the tests and verify they fail**

```bash
bun test packages/core/test/readers/recall-t0.test.ts
```

Expected: FAIL — either zod parse errors on the unknown fields, or test assertions that don't filter.

- [ ] **Step 4: Add the optional fields to `RecallRequest`**

In `packages/core/src/schemas/recall.ts`, find the `RecallRequest` zod schema (likely a `z.object({...})`) and add:

```ts
session_id: z.string().optional(),
event_types: z.array(z.string()).optional(),
```

- [ ] **Step 5: Plumb the fields into `queryT0`**

In `packages/core/src/readers/recall.ts`, update the `QueryT0Options` type (around line 189) to include the optional fields:

```ts
export interface QueryT0Options {
  query: string;
  limit: number;
  project_id: string | null;
  session_id?: string;
  event_types?: string[];
}
```

Update the `queryT0` SQL builder. Find the existing FTS5 query (it joins `t0_fts` with `t0_events`) and append `WHERE` clauses. Sketch:

```ts
export function queryT0(db: Database, opts: QueryT0Options): T0RecallResult[] {
  const sql = [
    `SELECT e.event_id, e.ts, e.event_type, snippet(t0_fts, ...) AS content_snippet, bm25(t0_fts) AS score`,
    `FROM t0_fts`,
    `JOIN t0_events e ON e.event_id = t0_fts.event_id`,
    `WHERE t0_fts MATCH ?`,
    opts.project_id !== null ? `AND e.project_id = ?` : ``,
    opts.session_id !== undefined ? `AND e.session_id = ?` : ``,
    opts.event_types && opts.event_types.length > 0
      ? `AND e.event_type IN (${opts.event_types.map(() => '?').join(',')})`
      : ``,
    `ORDER BY score DESC`,
    `LIMIT ?`,
  ].filter(Boolean).join(' ');

  const params: unknown[] = [opts.query];
  if (opts.project_id !== null) params.push(opts.project_id);
  if (opts.session_id !== undefined) params.push(opts.session_id);
  if (opts.event_types) params.push(...opts.event_types);
  params.push(opts.limit);

  return db.query<T0RecallResult, unknown[]>(sql).all(...params);
}
```

(The exact SQL depends on the existing `queryT0` body — match its column-list and snippet/bm25 parameters; the only changes are the appended WHERE clauses and the threaded params.)

- [ ] **Step 6: Plumb the fields through `RecallReader.recall`**

In `packages/core/src/readers/recall.ts`, find line 32 where `queryT0` is called and update:

```ts
const raw = queryT0(this.db, {
  query: req.query,
  limit,
  project_id: req.project_id,
  session_id: req.session_id,
  event_types: req.event_types,
});
```

Then in the t1 branch (around lines 56–80), apply the `session_id` filter to the t1 SQL. Update the existing parameter list to include `session_id`:

```ts
// existing SQL adds:
//   AND (? IS NULL OR r.session_id = ?)
const t1Rows = this.db
  .query<T1Row, [Float32Array, number, string | null, string | null, string | null, string | null]>(
    `SELECT r.rollup_id, r.project_id, r.session_id, r.started_at,
            r.first_prompt_excerpt, r.last_response_excerpt, v.distance
       FROM t1_vec v
       JOIN t1_rollups r ON r.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
        AND (? IS NULL OR r.project_id = ?)
        AND (? IS NULL OR r.session_id = ?)
      ORDER BY v.distance ASC`,
  )
  .all(qvec, limit, req.project_id, req.project_id, req.session_id ?? null, req.session_id ?? null);
```

t2 branch is unchanged (event_types is t0-only; t2 has no session_id-equivalent column we want to filter on for this phase).

- [ ] **Step 7: Run the tests and verify they pass**

```bash
bun test packages/core/test/readers/recall-t0.test.ts packages/core/test/readers/recall.test.ts
```

Expected: all pass — both the new filter tests and the existing recall tests.

- [ ] **Step 8: Run full core suite + typecheck**

```bash
bun test packages/core
bun run typecheck
```

Expected: all pass, 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/schemas/recall.ts packages/core/src/readers/recall.ts packages/core/test/readers/recall-t0.test.ts
git commit -m "feat(core): recall accepts session_id and event_types filters"
```

---

## Task 6: Mirror filters in MCP recall tool + CLI command

**Files:**
- Modify: `packages/mcp/src/tools/recall.ts`
- Modify: `packages/cli/src/commands/recall.ts`

Surface the new fields where users actually call recall.

- [ ] **Step 1: Inspect the MCP recall tool zod input schema**

```bash
sed -n '1,80p' packages/mcp/src/tools/recall.ts
```

- [ ] **Step 2: Add the fields to the MCP tool's zod input schema**

In `packages/mcp/src/tools/recall.ts`, find the input zod schema (a `z.object({...})` describing the tool's args) and add:

```ts
session_id: z.string().optional().describe('Limit results to a single chain or session.'),
event_types: z.array(z.string()).optional().describe('Limit t0 results to these event_type values (e.g. ["agent-thought","agent-response"]).'),
```

The handler at `packages/mcp/src/tools/recall.ts:18` already passes `parsed` straight to `daemon.recall(parsed)` — no further plumbing needed if the daemon's `/recall` route forwards the request body verbatim. Verify by greping:

```bash
grep -n "recall.*=.*async\|/recall" packages/daemon/src/routes/recall.ts | head
```

If the daemon route validates against `RecallRequest` (which we updated in Task 5), the new fields flow through with no daemon-side change.

- [ ] **Step 3: Add the CLI flags**

In `packages/cli/src/commands/recall.ts`, find the existing flag declarations (likely a yargs/commander style block) and add:

```ts
.option('session', {
  type: 'string',
  describe: 'Limit results to a single chain or session id',
})
.option('event-types', {
  type: 'string',
  describe: 'Comma-separated event_types to filter t0 results (e.g. agent-thought,agent-response)',
})
```

In the command handler, parse and forward:

```ts
const sessionId = argv.session as string | undefined;
const eventTypes = typeof argv['event-types'] === 'string'
  ? (argv['event-types'] as string).split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

// pass to the recall call:
const results = await client.recall({
  /* existing args */,
  session_id: sessionId,
  event_types: eventTypes,
});
```

(Field names will differ slightly based on the existing CLI framework — match the existing style.)

- [ ] **Step 4: Run typecheck and any MCP/CLI tests**

```bash
bun run typecheck
bun test packages/mcp packages/cli
```

Expected: 0 type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/recall.ts packages/cli/src/commands/recall.ts
git commit -m "feat(mcp,cli): expose session_id and event_types filters on recall"
```

---

## Task 7: Integration smoke test

**Files:**
- Create: `packages/e2e/test/smoke/fixtures/mock-acp-cli.ts` (or similar fixture path)
- Create: `packages/e2e/test/smoke/dispatch-t0-capture.test.ts`

End-to-end smoke through a live daemon and a deterministic mock ACP CLI. Asserts that all four event types land in `t0_events` for the chain's session, in order, and that `memory.recall` returns a CoT hit when scoped by `session_id`.

- [ ] **Step 1: Look at existing e2e smoke patterns**

```bash
cat packages/e2e/test/smoke/mcp-stdio-roundtrip.test.ts | head -80
ls packages/e2e/test/smoke/fixtures/ 2>/dev/null
```

Note how existing smokes spin up a daemon, register agents, and invoke MCP tools.

- [ ] **Step 2: Create the mock ACP CLI fixture**

Create `packages/e2e/test/smoke/fixtures/mock-acp-cli.ts`:

```ts
#!/usr/bin/env bun
/**
 * Mock ACP CLI for the dispatch-t0-capture smoke test.
 *
 * Speaks the JSON-RPC ACP protocol over stdio. On `initialize`, advertises
 * minimal capabilities. On `session/new`, returns a fixed sessionId. On
 * `session/prompt`, emits a deterministic sequence of session/update
 * notifications, then resolves with stopReason='end_turn'.
 */

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const SESSION_ID = 'mock-acp-session-1';

rl.on('line', async (line) => {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof req.method !== 'string') return;

  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '0.1.0', capabilities: {} } });
    return;
  }
  if (req.method === 'session/new') {
    send({ jsonrpc: '2.0', id: req.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (req.method === 'session/prompt') {
    // Emit a deterministic sequence of session/update notifications.
    const notify = (update: object) =>
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update } });

    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PHRASE_RESPONSE_AAA' } });
    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PHRASE_THOUGHT_BBB' } });
    notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      status: 'pending',
      input: { path: 'a.ts' },
    });
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      output: { ok: true },
    });

    // Tiny delay so notifications dispatch before the response.
    await new Promise((r) => setTimeout(r, 20));
    send({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
```

Make it executable:

```bash
chmod +x packages/e2e/test/smoke/fixtures/mock-acp-cli.ts
```

- [ ] **Step 3: Write the smoke test**

Create `packages/e2e/test/smoke/dispatch-t0-capture.test.ts`:

```ts
import { expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
// Reuse whatever helper(s) other smoke tests use to spin up a daemon, register agents, and call MCP tools.
import { spawnDaemon, registerAgent, mcpTool } from '../../helpers/smoke.js'; // adjust path to actual helper

let storageRoot: string;
let daemon: { stop: () => Promise<void>; storageRoot: string };
const MOCK_CLI = resolve(__dirname, 'fixtures/mock-acp-cli.ts');

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'phase-3a-smoke-'));
  daemon = await spawnDaemon({ storageRoot });

  // Register a 'mock-acp' agent that uses the stdio-acp adapter pointed at our mock CLI.
  await registerAgent(daemon, {
    name: 'mock-acp',
    adapter: 'stdio-acp',
    options: { command: 'bun', args: [MOCK_CLI] },
  });
});

afterAll(async () => {
  await daemon?.stop();
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

test('dispatch turn captures prompt + response + thought + tool_call as t0 events', async () => {
  const startResp = await mcpTool(daemon, 'chain_start', {
    agent: 'mock-acp',
    prompt: 'PHRASE_PROMPT_CCC',
  });
  const chainId = startResp.chain_id as string;

  await mcpTool(daemon, 'chain_wait', { chain_id: chainId, timeout_ms: 10_000 });

  // Verify t0 rows directly via sqlite.
  const db = new Database(join(daemon.storageRoot, 'penumbra.db'), { readonly: true });
  const rows = db
    .query<{ event_type: string; ts: string; payload_summary: string | null }, [string]>(
      `SELECT event_type, ts, payload_summary FROM t0_events WHERE session_id = ? ORDER BY ts ASC`,
    )
    .all(chainId);

  const types = rows.map((r) => r.event_type);
  expect(types).toContain('agent-prompt');
  expect(types).toContain('agent-response');
  expect(types).toContain('agent-thought');
  expect(types).toContain('agent-tool-use');
  expect(types[0]).toBe('agent-prompt');
  expect(types[types.length - 1]).toBe('agent-response');
  db.close();

  // Recall scoped by session_id should return a CoT hit.
  const recallResp = await mcpTool(daemon, 'memory_recall', {
    query: 'PHRASE_THOUGHT_BBB',
    session_id: chainId,
    include_raw: true,
    limit: 10,
  });
  const recallHits = recallResp.results ?? recallResp; // adjust to actual response shape
  const matched = recallHits.find((r: any) =>
    typeof r.body === 'string' && r.body.includes('PHRASE_THOUGHT_BBB'),
  );
  expect(matched).toBeDefined();
});
```

Adapt `spawnDaemon`, `registerAgent`, `mcpTool`, and the recall response unwrap to match the actual smoke helper APIs in this repo. Look at `mcp-stdio-roundtrip.test.ts` for the exact patterns.

- [ ] **Step 4: Run the smoke test**

```bash
bun test packages/e2e/test/smoke/dispatch-t0-capture.test.ts
```

Expected: PASS. If `chain_wait` times out, the most likely cause is the mock CLI not being marked executable or the registration not finding the binary — verify with `ls -l` and the daemon agent registry.

- [ ] **Step 5: Run the full smoke suite + typecheck**

```bash
bun test packages/e2e/test/smoke
bun run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/test/smoke/fixtures/mock-acp-cli.ts packages/e2e/test/smoke/dispatch-t0-capture.test.ts
git commit -m "test(e2e): smoke for dispatch t0 capture (prompt/response/thought/tool_call)"
```

---

## Final verification

After all 7 tasks land:

- [ ] **Full repo test pass**
  ```bash
  bun test
  bun run typecheck
  ```
  Expected: all pass, 0 type errors.

- [ ] **Live manual smoke**
  Roll the workers (SIGTERM + respawn so the new code is live), then:
  ```bash
  # Dispatch any real ACP agent (e.g. gemini-acp-pro) via chain_start, await completion,
  # then probe the DB for the four event types.
  sqlite3 /tmp/penumbra-live/penumbra.db \
    "SELECT event_type, COUNT(*) FROM t0_events WHERE source='agentchat' GROUP BY event_type"
  ```
  Expected: non-zero counts for `agent-prompt`, `agent-response`, plus `agent-thought` (where the agent emits thoughts) and `agent-tool-use` (where the dispatch involved tools).

- [ ] **Live recall**
  ```
  memory_recall { q: "<phrase from a recent dispatch response>", session_id: "<chain_id>" }
  ```
  Expected: at least one t0 hit with the matching phrase.

- [ ] **Worker stderr**
  Look at the running worker stderr (`tail -n 200 /tmp/penumbra-live/logs/worker-*.log` or similar):
  Expected: lines like `capture-port stats: sent=N failed=0` at the end of each dispatch.

---

## Self-Review Notes

- **Spec coverage:** Each Q1–Q8 decision in the spec maps to a task: Q1 (scope) is enforced by Task 3's switch arms; Q2 (per-message coalescing) is the heart of Task 2; Q3 (write path = observe reuse) is Task 4; Q4 (session_id mapping) is encoded in `CapturePort` (Task 2 test #7) and exercised in Task 7; Q5 (fire-and-forget) is the `void`/`.catch()` pattern in Task 2's `dispatch()`; Q6 (enum delta) is Task 1; Q7 (tool_call merge + 8 KB truncation) is Task 2 tests #4 and #6; Q8 (recall extension) is Tasks 5 and 6.
- **Type consistency:** `CapturePort` constructor opts in Task 2 match the construction call in Task 4. The adapter opts addition in Task 3 (`capturePort?: CapturePort`) matches the type passed in from runChatTurn in Task 4. The `RecallRequest` extension in Task 5 matches the MCP tool zod fields in Task 6.
- **Skipped:** No explicit unit test for the stdio-acp adapter wire-up in Task 3; the smoke test in Task 7 is the verification surface for that integration. Noted in Task 3 step 2.
