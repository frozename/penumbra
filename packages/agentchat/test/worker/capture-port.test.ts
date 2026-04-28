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
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].event_type).toBe('agent-thought');
  expect(f.calls[1].event_type).toBe('agent-tool-use');
});

test('4. tool_call start + terminal update → merged row with latency_ms', async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: 'tool_call', toolCallId: 'tc-1', status: 'pending', input: { path: 'a.ts' } });
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
  expect(JSON.stringify(r.payload_json.input).length).toBeLessThanOrEqual(8 * 1024 + 256);
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
  f.rejectNext(new Error('observe down'));
  f.resolveAll();
  const closing = port.close();
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
  await new Promise((r) => setTimeout(r, 10));
  expect(closeResolved).toBe(false);
  f.resolveAll();
  await closing;
  expect(closeResolved).toBe(true);
});
