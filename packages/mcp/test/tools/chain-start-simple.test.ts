import { expect, test, mock } from 'bun:test';
import {
  chainStartSimpleHandler,
} from '../../src/tools/chain-start-simple.js';
import { ProjectIdRequiredError } from '../../src/tools/chain-start.js';

test('chain_start_simple throws project_id_required when env gate is set and project_id is omitted', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = 'true';
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartSimpleHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expect(
    handler({ initial_agent: 'planner', message: 'hi' }),
  ).rejects.toThrow(ProjectIdRequiredError);

  if (oldRequireExplicit === undefined) {
    delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  } else {
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }

  expect(daemon.startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledOnce();
});

test('chain_start_simple succeeds when env gate is off and project_id is omitted', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartSimpleHandler(daemon);

  await handler({ initial_agent: 'planner', message: 'hi' });

  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'planner',
    message: 'hi',
    task_class: 'STANDARD',
    task_type: 'debug_diagnose',
    use_worktree: false,
    max_hops: 2,
    trust_mode: 'config',
  });
});

test('chain_start_simple forwards project_id through to chain_start', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartSimpleHandler(daemon);

  await handler({ initial_agent: 'planner', message: 'hi', project_id: 'llamactl' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
    task_class: 'STANDARD',
    task_type: 'debug_diagnose',
    project_id: 'llamactl',
    }));
});

test('chain_start_simple forwards long-lived dispatch identity fields when supplied', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartSimpleHandler(daemon);

  await handler({
    initial_agent: 'planner',
    message: 'hi',
    dispatch_kind: 'long_lived_tick',
    long_lived_agent_id: 'agent-1',
    long_lived_tick_id: 'tick-1',
  } as any);

  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'planner',
    message: 'hi',
    dispatch_kind: 'long_lived_tick',
    long_lived_agent_id: 'agent-1',
    long_lived_tick_id: 'tick-1',
    task_class: 'STANDARD',
    task_type: 'debug_diagnose',
    use_worktree: false,
    max_hops: 2,
    trust_mode: 'config',
  });
});
