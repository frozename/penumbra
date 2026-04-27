import { expect, test, mock } from 'bun:test';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';

test('dispatcher.cancel(cid) before handle() starts dispatch should still abort', async () => {
  let signalSent: AbortSignal | null = null;
  const dispatchStarted = new Promise<void>((resolve) => {
    // We'll resolve this once dispatch is called
  });

  const deps: any = {
    claim: mock().mockResolvedValue({ status: 'dispatched' }),
    dispatch: mock().mockImplementation(async (_h, _oc, signal) => {
      signalSent = signal;
      return new Promise((resolve) => {
        const onAbort = () => {
          resolve({ next: null, text: 'aborted', agent: 'x' });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }),
    postProgress: mock().mockResolvedValue(undefined),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    concurrency: 4,
  };

  const dispatcher = createWorkerDispatcher(deps);
  const handoff = { handoff_id: 'h1', conversation_id: 'c1', to_agent: 'a1' };

  // Trigger cancel BEFORE handle
  dispatcher.cancel('c1');

  // Now handle
  void dispatcher.handle(handoff);

  await dispatcher.idle();
  
  // If the fix is NOT in place, dispatch might have started and finished normally or it might have stayed pending.
  // In the current implementation, cancel() does nothing if cid is not in activeAborts.
  // So handleOne will proceed and call dispatch.
  expect(deps.dispatch).toHaveBeenCalled();
  expect(signalSent!.aborted).toBe(true);
});
