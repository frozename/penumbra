import { expect, test, mock } from 'bun:test';
import { startEventSource, type EventSourceClient } from '../../src/worker/event-source.js';

function makeClient(overrides: Partial<EventSourceClient> = {}): EventSourceClient {
  return {
    listHandoffs: mock().mockResolvedValue({ handoffs: [] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      // never yields; pretend SSE is alive but quiet
      await new Promise<void>(() => {});
      // unreachable
    }),
    ...overrides,
  };
}

test('drains backlog from listHandoffs(status=approved,redirected) on startup', async () => {
  const handler = mock();
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({
      handoffs: [{ handoff_id: 'a', status: 'approved' }, { handoff_id: 'b', status: 'redirected' }],
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved', 'redirected'], onEvent: handler, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 30));
  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls.map((c) => c[0].handoff_id).sort()).toEqual(['a', 'b']);
  await stop();
});

test('SSE events are delivered to handler', async () => {
  const handler = mock();
  const client = makeClient({
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: 'sse-1', status: 'approved' };
      yield { handoff_id: 'sse-2', status: 'approved' };
      // hold open
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 1000 });
  await new Promise((r) => setTimeout(r, 60));
  expect(handler).toHaveBeenCalledTimes(2);
  await stop();
});

test('dedupes by handoff_id across SSE + poll', async () => {
  const handler = mock();
  let pollCount = 0;
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => {
      pollCount++;
      return { handoffs: [{ handoff_id: 'x', status: 'approved' }] };
    }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: 'x', status: 'approved' };
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  // Even though SSE emits 'x' AND polling sees 'x' multiple times, handler runs once.
  expect(handler).toHaveBeenCalledTimes(1);
  await stop();
});

test('SSE error switches to polling and resumes when SSE recovers', async () => {
  const handler = mock();
  let sseAttempt = 0;
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({ handoffs: [{ handoff_id: 'p', status: 'approved' }] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      sseAttempt++;
      if (sseAttempt === 1) throw new Error('boom');
      yield { handoff_id: 'sse-after-recover', status: 'approved' };
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({
    client, statuses: ['approved'], onEvent: handler,
    pollIntervalMs: 30, sseBackoffStartMs: 5,
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(sseAttempt).toBeGreaterThanOrEqual(2);
  const ids = handler.mock.calls.map((c) => c[0].handoff_id);
  expect(ids).toContain('p');
  expect(ids).toContain('sse-after-recover');
  await stop();
});

test('stop() cancels SSE iterator and stops polling', async () => {
  const handler = mock();
  const client = makeClient();
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 10 });
  await new Promise((r) => setTimeout(r, 25));
  await stop();
  const callsBefore = handler.mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(handler.mock.calls.length).toBe(callsBefore);
});