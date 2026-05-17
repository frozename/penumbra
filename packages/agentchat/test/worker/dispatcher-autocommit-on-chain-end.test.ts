import { expect, test, mock } from 'bun:test';
import { createWorkerDispatcher, type WorkerDispatcherDeps } from '../../src/worker/dispatcher.js';

const handoff = {
  handoff_id: 'h-auto',
  ts: 't',
  project_id: 'proj-1',
  conversation_id: 'conv-1',
  from_agent: 'planner',
  to_agent: 'executor',
  to_role: null,
  message: 'm',
  status: 'approved',
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
};

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
    complete: mock().mockResolvedValue(undefined),
    log: { info: mock(), warn: mock(), debug: mock() } as any,
    concurrency: 1,
    onDispatchEvent: mock(),
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: false, dirty: false, committed: false }),
    autocommitOnChainEnd: mock().mockResolvedValue(undefined),
    ...over,
  };
}

test('no changes skips autocommit and still runs onChainEnd', async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const onDispatchEvent = mock();
  const d = deps({
    onChainEnd,
    onDispatchEvent,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: false, dirty: false, committed: false }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expect(onDispatchEvent.mock.calls.some((call) => call[0]?.kind === 'autocommit_on_chain_end')).toBe(false);
  expect(onChainEnd).toHaveBeenCalledWith(handoff, 'completed', false, false, false);
});

test('real commit skips autocommit and still runs onChainEnd', async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const d = deps({
    onChainEnd,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: true, dirty: false, committed: true }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expect(onChainEnd).toHaveBeenCalledWith(handoff, 'completed', true, false, true);
});

test('dirty uncommitted completed dispatch autocommits before onChainEnd', async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock().mockResolvedValue(undefined);
  const onDispatchEvent = mock();
  const d = deps({
    onChainEnd,
    onDispatchEvent,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: true, dirty: true, committed: false }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).toHaveBeenCalledTimes(1);
  expect(autocommitOnChainEnd).toHaveBeenCalledWith(handoff);
  expect(onDispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'autocommit_on_chain_end',
    handoff_id: 'h-auto',
    conversation_id: 'conv-1',
    project_id: 'proj-1',
    agent: 'executor',
  }));
  expect(onChainEnd).toHaveBeenCalledWith(handoff, 'completed', true, true, false);
});

test('autocommit is suppressed on non-success reasons', async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const d = deps({
    onChainEnd,
    autocommitOnChainEnd,
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: 'untrusted',
      text: 'result',
      agent: 'executor',
    }),
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: true, dirty: true, committed: false }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expect(onChainEnd).toHaveBeenCalledWith(handoff, 'cancelled', true, true, false);
});

test('autocommit failures warn and still run onChainEnd', async () => {
  const onChainEnd = mock();
  const warn = mock();
  const d = deps({
    onChainEnd,
    log: { info: mock(), warn, debug: mock() } as any,
    autocommitOnChainEnd: mock().mockRejectedValue(new Error('git commit failed')),
    getWorktreeSnapshot: mock().mockResolvedValue({ worktreeChanged: true, dirty: true, committed: false }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(warn).toHaveBeenCalledWith(expect.objectContaining({
    component: 'autocommit-on-chain-end',
    handoff_id: 'h-auto',
  }), 'autocommit on chain end failed');
  expect(onChainEnd).toHaveBeenCalledWith(handoff, 'completed', true, true, false);
});
