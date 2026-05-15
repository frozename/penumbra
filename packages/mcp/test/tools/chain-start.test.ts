import { expect, test, mock } from 'bun:test';
import {
  chainStartHandler,
  ChainStartInputShape,
  RegistryUnavailableError,
  ProjectIdRequiredError,
} from '../../src/tools/chain-start.js';

test('ChainStartInputShape requires initial_agent and message', () => {
  expect(() => (ChainStartInputShape as any).initial_agent.parse(undefined)).toThrow();
});

test('ChainStartInputShape requires task_class', () => {
  expect(() => ChainStartInputShape.task_class.parse(undefined)).toThrow();
});

test.each(['BOUNDARY', 'STANDARD', 'TRIVIAL'] as const)(
  'chain.start handler forwards task_class=%s to daemon.startChain',
  async (task_class) => {
    const daemon = {
      startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
    } as any;
    const handler = chainStartHandler(daemon);

    await handler({ initial_agent: 'planner', message: 'hi', task_class });

    expect(daemon.startChain).toHaveBeenCalledWith({
      initial_agent: 'planner',
      message: 'hi',
      task_class,
    });
  },
);

test('chain.start handler proxies to daemon.startChain and returns conversation_id + handoff_id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  const res = await handler({ initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all',
  });
  expect(res.content[0].type).toBe('text');
  expect(res.content[0].text).toMatch(/^◌ chain_start  /);
  expect(res.content[0].text).toContain('"conversation_id": "conv-1"');
  expect(res.content[0].text).toContain('"handoff_id": "h-1"');
});

test('chain.start handler forwards task_type hints for routing', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: 'executor', message: 'hi', task_type: 'implement_substantial' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    task_type: 'implement_substantial',
  });
});

test('chain.start handler forwards branch_base when supplied', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: 'executor', message: 'hi', branch_base: 'agent/h-2' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    branch_base: 'agent/h-2',
  });
});

test('chain.start handler forwards open_pr_on_review when supplied', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: 'executor', message: 'hi', open_pr_on_review: true });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    open_pr_on_review: true,
  });
});

test('chain.start handler forwards long-lived dispatch identity fields when supplied', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  await handler({
    initial_agent: 'executor',
    message: 'hi',
    dispatch_kind: 'long_lived_tick',
    long_lived_agent_id: 'agent-1',
    long_lived_tick_id: 'tick-1',
  });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'executor',
    message: 'hi',
    dispatch_kind: 'long_lived_tick',
    long_lived_agent_id: 'agent-1',
    long_lived_tick_id: 'tick-1',
  });
});

test('chain.start auto-resolves project_id from cwd when caller omits it', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
    project_id: 'llamactl',
  }));
});

test('chain.start throws cwd_not_registered when no project_id and cwd resolver returns undefined', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue(undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expect(
    handler({ initial_agent: 'planner', message: 'hi', use_worktree: true }),
  ).rejects.toThrow(/cwd_not_registered/);
  expect(daemon.startChain).not.toHaveBeenCalled();
});

test('chain.start does not throw cwd_not_registered when use_worktree is false and resolver returns undefined', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue(undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi', use_worktree: false });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
    use_worktree: false,
  }));
  const call = (daemon.startChain as any).mock.calls[0][0];
  expect(call.project_id).toBeUndefined();
});

test('chain.start does not auto-resolve when caller passes explicit project_id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('would-be-wrong');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi', project_id: 'sirius' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    project_id: 'sirius',
  }));
  expect(resolver).not.toHaveBeenCalled();
});

test('chain.start does not auto-resolve when caller explicitly passes project_id: null', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: 'planner', message: 'hi', project_id: null });

  expect(resolver).not.toHaveBeenCalled();
  const call = (daemon.startChain as any).mock.calls[0][0];
  expect(call.project_id).toBeUndefined();
});

test('chain.start re-throws registry_unavailable when cwd resolver cannot load registry', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockImplementation(() => {
    throw new RegistryUnavailableError('failed to read project registry');
  });
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expect(
    handler({ initial_agent: 'planner', message: 'hi' }),
  ).rejects.toThrow(/registry_unavailable/);
  expect(daemon.startChain).not.toHaveBeenCalled();
});

test('chain.start without resolver opt passes through (legacy behavior)', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: 'planner', message: 'hi' });

  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    initial_agent: 'planner',
    message: 'hi',
  }));
  const call = (daemon.startChain as any).mock.calls[0][0];
  expect(call.project_id).toBeUndefined();
});

test('chain.start explicit-project_id-no-warning', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  const res = await handler({ initial_agent: 'planner', message: 'hi', project_id: 'sirius' });

  expect(resolver).not.toHaveBeenCalled();
  expect(res).not.toHaveProperty('resolution_warning');
  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    project_id: 'sirius',
  }));
});

test('chain.start cwd-fallback-emits-warning-with-resolved-id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  const res = await handler({ initial_agent: 'planner', message: 'hi' });

  expect(res).toHaveProperty('resolution_warning', {
    code: 'project_id_inferred_from_mcp_cwd',
    resolved_project_id: 'llamactl',
  });
  expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
    project_id: 'llamactl',
  }));
});

test('chain.start hard-mode-env-set-throws-with-correct-code-and-hint', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const resolver = mock().mockReturnValue('llamactl');
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  let error: unknown;
  try {
    await handler({ initial_agent: 'planner', message: 'hi' });
  } catch (err) {
    error = err;
  } finally {
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
  }
  expect(error).toBeInstanceOf(ProjectIdRequiredError);
  const err = error as ProjectIdRequiredError;
  expect(err.code).toBe('project_id_required');
  expect(err.resolvedProjectId).toBe('llamactl');
  expect(err.hint).toBe('pass project_id explicitly, or unset PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy default');
  expect(daemon.startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledOnce();
});

test.each(['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON'])(
  'chain.start env-knob accepts %s case-insensitively',
  async (value) => {
    const daemon = {
      startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
    } as any;
    const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = value;
    const resolver = mock().mockReturnValue('llamactl');
    const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

    await expect(
      handler({ initial_agent: 'planner', message: 'hi' }),
    ).rejects.toBeInstanceOf(ProjectIdRequiredError);
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
    expect(daemon.startChain).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
  }
);

test.each(['', '0', 'false', 'FALSE', 'no', 'off', 'maybe', ' '])(
  'chain.start env-knob rejects %s and keeps legacy warning path',
  async (value) => {
    const daemon = {
      startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
    } as any;
    const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = value;
    const resolver = mock().mockReturnValue('llamactl');
    const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

    const res = await handler({ initial_agent: 'planner', message: 'hi' });
    expect(res).toHaveProperty('resolution_warning', {
      code: 'project_id_inferred_from_mcp_cwd',
      resolved_project_id: 'llamactl',
    });
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
    expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'llamactl',
    }));
    expect(resolver).toHaveBeenCalledOnce();
  }
);
