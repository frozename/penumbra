import { expect, test } from 'bun:test';
import { runWorkerControlListener } from '../../src/worker/control-listener.js';

test('throttles control-listener reconnect log to once per window and reports suppressedCount', async () => {
  const warns: any[] = [];
  const log = {
    warn: (obj: any, msg: string) => warns.push({ obj, msg }),
    error: () => {},
  };

  let subscribeCalls = 0;
  const client = {
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

