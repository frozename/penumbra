import { expect, test, mock } from 'bun:test';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';

test('dispatcher.cancel(cid) triggers abort on active dispatch', async () => {
  let signalSent: AbortSignal | null = null;
  let dispatchStarted = false;

  const deps: any = {
    claim: mock().mockResolvedValue({ status: 'dispatched' }),
    dispatch: mock().mockImplementation(async (_h, _oc, signal) => {
      signalSent = signal;
      dispatchStarted = true;
      // Wait for signal or timeout
      return new Promise((resolve) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          resolve({ next: null, text: 'aborted', agent: 'x' });
        };
        signal.addEventListener('abort', onAbort);
      });
    }),
    postProgress: mock().mockResolvedValue(undefined),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    concurrency: 4,
  };

  const dispatcher = createWorkerDispatcher(deps);
  const handoff = { handoff_id: 'h1', conversation_id: 'c1', to_agent: 'a1' };

  // Start dispatch
  void dispatcher.handle(handoff);

  // Wait for it to start
  while (!dispatchStarted) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(signalSent!.aborted).toBe(false);

  // Trigger cancel
  dispatcher.cancel('c1');

  await dispatcher.idle();
  expect(signalSent!.aborted).toBe(true);
});
