import { expect, test } from 'bun:test';
import { handleControlEvent, runWorkerControlListener } from '../../src/worker/control-listener.js';

test('handleControlEvent emits cancel.received before dispatching cancel', () => {
  const events: any[] = [];
  const cancels: Array<{ conversation_id: string; handoff_id: string }> = [];

  handleControlEvent(
    { type: 'cancel', conversation_id: 'c1', handoff_id: 'h1' },
    {
      client: {
        sendProbeAck: async () => {},
        subscribeWorkerControl: async function* () {},
      },
      dispatcher: { cancel: (conversation_id, handoff_id) => cancels.push({ conversation_id, handoff_id }) },
      workerId: 'w1',
      onEvent: (event) => events.push(event),
    },
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    handoff_id: 'h1',
    worker_id: 'w1',
    source: 'worker',
    kind: 'cancel.received',
    meta: { source: 'sse' },
  });
  expect(cancels).toEqual([{ conversation_id: 'c1', handoff_id: 'h1' }]);
});

test('handleControlEvent sends ping ACK only for matching worker', () => {
  const acks: Array<[string, string]> = [];

  handleControlEvent(
    { type: 'ping', worker_id: 'w1', probe_id: 'p1' },
    {
      client: {
        sendProbeAck: async (worker_id, probe_id) => acks.push([worker_id, probe_id]),
        subscribeWorkerControl: async function* () {},
      },
      dispatcher: { cancel: () => {} },
      workerId: 'w1',
    },
  );

  expect(acks).toEqual([['w1', 'p1']]);
});

test('handleControlEvent ignores ping not addressed to this worker', () => {
  const acks: Array<[string, string]> = [];

  handleControlEvent(
    { type: 'ping', worker_id: 'w2', probe_id: 'p1' },
    {
      client: {
        sendProbeAck: async (worker_id, probe_id) => acks.push([worker_id, probe_id]),
        subscribeWorkerControl: async function* () {},
      },
      dispatcher: { cancel: () => {} },
      workerId: 'w1',
    },
  );

  expect(acks).toHaveLength(0);
});

test('reconnects when control stream ends cleanly', async () => {
  const cancels: Array<{ conversation_id: string; handoff_id: string }> = [];
  const abort = new AbortController();
  let subscribeCalls = 0;

  const client = {
    sendProbeAck: async () => {},
    subscribeWorkerControl: async function* () {
      subscribeCalls++;
      if (subscribeCalls === 2) {
        yield { type: 'cancel', conversation_id: 'c1', handoff_id: 'h1' };
        abort.abort();
      }
    },
  };

  await runWorkerControlListener({
    client,
    dispatcher: {
      cancel: (conversation_id, handoff_id) => cancels.push({ conversation_id, handoff_id }),
    },
    signal: abort.signal,
    log: { warn: () => {}, error: () => {} },
    sleep: async () => {},
  });

  expect(subscribeCalls).toBe(2);
  expect(cancels).toEqual([{ conversation_id: 'c1', handoff_id: 'h1' }]);
});

test('throttles control-listener reconnect log to once per window and reports suppressedCount', async () => {
  const warns: any[] = [];
  const log = {
    warn: (obj: any, msg: string) => warns.push({ obj, msg }),
    error: () => {},
  };

  let subscribeCalls = 0;
  const client = {
    sendProbeAck: async () => {},
    subscribeWorkerControl: async function* () {
      subscribeCalls++;
      throw new Error(`boom-${subscribeCalls}`);
    },
  };

  const dispatcher = { cancel: () => {} };
  const abort = new AbortController();

  let nowMs = 0;
  let warnsAfterFive = 0;
  const sleep = async () => {
    if (subscribeCalls === 5) {
      warnsAfterFive = warns.length;
      nowMs = 60_001; // advance past 60s window for the next error
    }
    if (subscribeCalls >= 6) abort.abort();
  };

  await runWorkerControlListener({
    client,
    dispatcher,
    signal: abort.signal,
    log,
    sleep,
    now: () => nowMs,
    streamErrorLogThrottleMs: 60_000,
  });

  expect(warnsAfterFive).toBe(1);
  expect(warns.length).toBe(2);
  expect(warns[0].msg).toBe('control listener stream error; reconnecting in 5s');
  expect(warns[1].obj.suppressedCount).toBe(4);
});
