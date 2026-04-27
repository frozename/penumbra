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

test('dispatcher.stop() aborts all active dispatches', async () => {
  let signal1: AbortSignal | null = null;
  let signal2: AbortSignal | null = null;
  let started1 = false;
  let started2 = false;

  const deps: any = {
    claim: mock().mockResolvedValue({ status: 'dispatched' }),
    dispatch: mock().mockImplementation(async (_h, _oc, signal) => {
      if (!signal1) signal1 = signal;
      else signal2 = signal;
      
      if (!started1) started1 = true;
      else started2 = true;

      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ next: null, text: 'aborted', agent: 'x' });
        }, { once: true });
      });
    }),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    concurrency: 4,
  };

  const dispatcher = createWorkerDispatcher(deps);
  void dispatcher.handle({ handoff_id: 'h1', conversation_id: 'c1', to_agent: 'a1' });
  void dispatcher.handle({ handoff_id: 'h2', conversation_id: 'c2', to_agent: 'a2' });

  while (!started1 || !started2) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(signal1!.aborted).toBe(false);
  expect(signal2!.aborted).toBe(false);

  dispatcher.stop();

  expect(signal1!.aborted).toBe(true);
  expect(signal2!.aborted).toBe(true);
});

test('dispatcher.cancel(cid) before handle() starts dispatch should still abort', async () => {
  let signalSent: AbortSignal | null = null;

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
    complete: mock().mockResolvedValue(undefined),
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
  
  expect(deps.dispatch).toHaveBeenCalled();
  expect(signalSent!.aborted).toBe(true);
});
