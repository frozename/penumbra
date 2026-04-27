import { expect, test, mock } from 'bun:test';
import { createWorkerDispatcher, type WorkerDispatcherDeps } from '../../src/worker/dispatcher.js';
import { PenumbraHttpError } from '../../src/penumbra-client.js';

const baseHandoff = (id: string, conv = 'c1') => ({
  handoff_id: id, ts: 't', project_id: null, conversation_id: conv,
  from_agent: 'planner', to_agent: 'executor', to_role: null, message: 'm',
  status: 'approved', resolved_by: null, resolved_at: null, redirected_to: null,
  triggered_by_event_id: null, chain_max_hops: null, chain_trust_mode: null,
});

function deps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: 'dispatched' }),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: 'no_mention',
      text: 'result',
      agent: 'executor',
    }),
    postProgress: mock().mockResolvedValue(undefined),
    log: { info: () => {}, warn: () => {}, debug: () => {} } as any,
    concurrency: 4,
    ...over,
  };
}

test('claim called once per event; dispatch called once on success', async () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.claim).toHaveBeenCalledTimes(1);
  expect(d.dispatch).toHaveBeenCalledTimes(1);
  expect(d.postProgress).toHaveBeenCalled();
});

test('progress events are emitted in order', async () => {
  const d = deps({
    dispatch: mock().mockImplementation(async (_h, onChunk) => {
      onChunk('hi');
      onChunk(' there');
      return { next: null, terminatedReason: 'no_mention', text: 'hi there', agent: 'executor' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();

  // hop-start, tokens, hop-end
  const calls = d.postProgress.mock.calls.map((c) => (c[1] as any).type);
  expect(calls[0]).toBe('hop-start');
  expect(calls).toContain('token');
  expect(calls[calls.length - 1]).toBe('hop-end');
});

test('lost claim race (claim throws 409): dispatch is NOT called; no rethrow', async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError('/handoffs/h1/claim', 409)),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).not.toHaveBeenCalled();
});

test('claim 404 is treated as terminal, not retryable', async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError('/handoffs/h1/claim', 404)),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(onClaimRetryable).not.toHaveBeenCalled();
});

test('claim 500 is retryable: onClaimRetryable is invoked with the handoff_id', async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError('/handoffs/h1/claim', 500)),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledTimes(1);
  expect(onClaimRetryable).toHaveBeenCalledWith('h1');
});

test('claim network error (non-HTTP) is retryable: onClaimRetryable is invoked', async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED')),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledWith('h1');
});

test('claim 408 (timeout) and 429 (rate-limit) are retryable', async () => {
  for (const status of [408, 429]) {
    const onClaimRetryable = mock();
    const d = deps({
      claim: mock().mockRejectedValue(new PenumbraHttpError('/handoffs/h1/claim', status)),
      onClaimRetryable,
    });
    const dispatcher = createWorkerDispatcher(d);
    await dispatcher.handle(baseHandoff('h1'));
    await dispatcher.idle();
    expect(onClaimRetryable).toHaveBeenCalledWith('h1');
  }
});

test('two handoffs for same conversation are serialized', async () => {
  let inflight = 0; let maxInflight = 0;
  const d = deps({
    dispatch: mock().mockImplementation(async () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([dispatcher.handle(baseHandoff('h1', 'cA')), dispatcher.handle(baseHandoff('h2', 'cA'))]);
  await dispatcher.idle();
  expect(maxInflight).toBe(1);
  expect(d.dispatch).toHaveBeenCalledTimes(2);
});

test('cross-conversation dispatch parallelizes up to concurrency cap', async () => {
  let inflight = 0; let maxInflight = 0;
  const d = deps({
    concurrency: 2,
    dispatch: mock().mockImplementation(async () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([
    dispatcher.handle(baseHandoff('h1', 'cA')),
    dispatcher.handle(baseHandoff('h2', 'cB')),
    dispatcher.handle(baseHandoff('h3', 'cC')),
  ]);
  await dispatcher.idle();
  expect(maxInflight).toBeLessThanOrEqual(2);
  expect(maxInflight).toBeGreaterThanOrEqual(2);
});

test('dispatch throw releases lock and semaphore; subsequent handoffs proceed', async () => {
  let calls = 0;
  const d = deps({
    dispatch: mock().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('adapter blew up');
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1', 'cA'));
  await dispatcher.handle(baseHandoff('h2', 'cA'));
  await dispatcher.idle();
  expect(d.dispatch).toHaveBeenCalledTimes(2);
});
