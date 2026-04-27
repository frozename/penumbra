import { expect, test, mock } from 'bun:test';
import { runAutoChain } from '../../src/cli/auto-loop.js';
import type { ChatTurnResult } from '../../src/cli/loop.js';

function mockConfig() {
  return { agents: [], default_roles: {} };
}
const mockConv = { id: 'c1', project_id: null };

test('chain naturally terminates when next_mention is null', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done',
    prompt_event_id: 'p1',
    response_event_id: 'r1',
    next_mention: null,
    mentions: [],
    error: undefined,
  } as ChatTurnResult);
  const createHandoff = mock();
  const approve = mock();

  const res = await runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 5,
    transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(res.hops).toBe(1);
  expect(res.terminatedReason).toBe('no_mention');
  expect(createHandoff).not.toHaveBeenCalled();
});

test('emits chain-terminated t0 event on completion', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done',
    prompt_event_id: 'p1',
    response_event_id: 'r1',
    next_mention: null,
    mentions: [],
  } as ChatTurnResult);
  const observe = mock().mockResolvedValue({ event_id: 'e' });

  await runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 5,
    transcriptBudget: 1000,
    observe,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  const terminatedEvent = observe.mock.calls.find((c: any) => c[0].event_type === 'chain-terminated');
  expect(terminatedEvent).toBeDefined();
  expect(terminatedEvent[0].payload_json).toEqual({
    reason: 'completed',
    hop_count: 1,
    conversation_id: 'c1',
    terminal_handoff_id: undefined,
  });
});

test('hop cap reached -> creates handoff but does not approve, returns capped indicator', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'passing the buck',
    prompt_event_id: 'p',
    response_event_id: 'r',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h1', status: 'pending' });
  const approve = mock();

  const res = await runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 1, // Cap at 1
    transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(res.hops).toBe(1);
  expect(res.terminatedReason).toBe('max_hops');
  expect(res.cappedHandoffId).toBe('h1');
  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
});

test('each hop after the first calls approve with resolved_by auto and transcript grows', async () => {
  const runChatTurn = mock()
    .mockResolvedValueOnce({
      text: 'step 1',
      prompt_event_id: 'p1',
      response_event_id: 'r1',
      next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
      mentions: [],
    } as ChatTurnResult)
    .mockResolvedValueOnce({
      text: 'step 2',
      prompt_event_id: 'p2',
      response_event_id: 'r2',
      next_mention: null,
      mentions: [],
    } as ChatTurnResult);

  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h1', status: 'pending' });
  const approve = mock();

  const res = await runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 5,
    transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(res.hops).toBe(2);
  expect(res.terminatedReason).toBe('no_mention');
  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve.mock.calls[0]).toEqual(['h1', { resolved_by: 'auto' }]);
  
  // Hop 2 should have received a prompt with the transcript
  const hop2Call = runChatTurn.mock.calls[1]![0];
  expect(hop2Call.initialAgent).toBe('executor');
  expect(hop2Call.prompt).toContain('[user]: hi');
  expect(hop2Call.prompt).toContain('From @planner: step 1');
});

test('mid-chain dispatch error stops loop, no handoff created', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'failed',
    prompt_event_id: 'p',
    response_event_id: 'r',
    next_mention: null,
    mentions: [],
    error: 'adapter failed',
  } as ChatTurnResult);
  const createHandoff = mock();

  const res = await runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 5,
    transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff,
    approve: mock(),
    runChatTurn,
  });

  expect(res.hops).toBe(1);
  expect(res.terminatedReason).toBe('error');
  expect(createHandoff).not.toHaveBeenCalled();
});

test('mid-chain createHandoff failure stops loop and surfaces error', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'passing',
    prompt_event_id: 'p',
    response_event_id: 'r',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockRejectedValue(new Error('daemon down'));

  await expect(runAutoChain({
    config: mockConfig(),
    initialAgent: 'planner',
    userMessage: 'hi',
    conversation: mockConv,
    maxHops: 5,
    transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff,
    approve: mock(),
    runChatTurn,
  })).rejects.toThrow('daemon down');
});

test('trustMode=config: untrusted edge stops chain and leaves handoff pending', async () => {
  const cfg = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: [] },
      { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock().mockResolvedValue({
    text: 'go @executor',
    prompt_event_id: 'p',
    response_event_id: 'r',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-untrusted', status: 'pending' });
  const approve = mock();

  const res = await runAutoChain({
    config: cfg, initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
    trustMode: 'config',
  });

  expect(res.terminatedReason).toBe('untrusted');
  expect(res.cappedHandoffId).toBe('h-untrusted');
  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
});

test('trustMode=config: trusted edge auto-approves and continues', async () => {
  const cfg = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
      { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock()
    .mockResolvedValueOnce({
      text: '@executor go',
      prompt_event_id: 'p1', response_event_id: 'r1',
      next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
      mentions: [],
    } as ChatTurnResult)
    .mockResolvedValueOnce({
      text: 'done',
      prompt_event_id: 'p2', response_event_id: 'r2',
      next_mention: null,
      mentions: [],
    } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-trusted', status: 'pending' });
  const approve = mock().mockResolvedValue({ handoff_id: 'h-trusted', status: 'approved' });

  const res = await runAutoChain({
    config: cfg, initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
    trustMode: 'config',
  });

  expect(res.hops).toBe(2);
  expect(res.terminatedReason).toBe('no_mention');
  expect(approve).toHaveBeenCalledWith('h-trusted', { resolved_by: 'auto' });
});

test('projectContext is included in the prompt for hops 2+', async () => {
  const captured: string[] = [];
  const runChatTurn = mock()
    .mockImplementationOnce(async (input: any) => {
      captured.push(input.prompt ?? input.userMessage);
      return {
        text: '@executor go',
        prompt_event_id: 'p1', response_event_id: 'r1',
        next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
        mentions: [],
      } as ChatTurnResult;
    })
    .mockImplementationOnce(async (input: any) => {
      captured.push(input.prompt ?? input.userMessage);
      return {
        text: 'done', prompt_event_id: 'p2', response_event_id: 'r2',
        next_mention: null, mentions: [],
      } as ChatTurnResult;
    });

  await runAutoChain({
    config: mockConfig(), initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock().mockResolvedValue({ handoff_id: 'h', status: 'pending' }),
    approve: mock().mockResolvedValue({ handoff_id: 'h', status: 'approved' }),
    runChatTurn,
    projectContext: 'Repo: foo\nLang: TS',
  });

  // Hop 1 sees the original userMessage (no transcript yet, no buildNextPrompt call).
  expect(captured[0]).toBe('hi');
  // Hop 2 sees the transcript-bundled prompt, which must include the project context.
  expect(captured[1]).toContain('# Project context\nRepo: foo\nLang: TS');
});

test('trustMode=all: ignores auto_approve_to (back-compat for --auto)', async () => {
  const cfg = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: [], auto_approve_to: [] },
      { name: 'executor', adapter: 'a', options: {}, roles: [], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock()
    .mockResolvedValueOnce({
      text: '@executor go',
      prompt_event_id: 'p1', response_event_id: 'r1',
      next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
      mentions: [],
    } as ChatTurnResult)
    .mockResolvedValueOnce({
      text: 'done', prompt_event_id: 'p2', response_event_id: 'r2',
      next_mention: null, mentions: [],
    } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-all', status: 'pending' });
  const approve = mock().mockResolvedValue({ handoff_id: 'h-all', status: 'approved' });

  const res = await runAutoChain({
    config: cfg, initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
    trustMode: 'all',
  });

  expect(res.terminatedReason).toBe('no_mention');
  expect(approve).toHaveBeenCalledTimes(1);
});

test('emits chain-terminated with reason=max_hops when hop cap is hit', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'passing',
    prompt_event_id: 'p',
    response_event_id: 'r',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const observe = mock().mockResolvedValue({ event_id: 'e' });

  await runAutoChain({
    config: mockConfig(), initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 1, transcriptBudget: 1000,
    observe,
    createHandoff: mock().mockResolvedValue({ handoff_id: 'h1', status: 'pending' }),
    approve: mock(),
    runChatTurn,
  });

  const terminatedEvent = observe.mock.calls.find((c: any) => c[0].event_type === 'chain-terminated');
  expect(terminatedEvent).toBeDefined();
  expect(terminatedEvent[0].payload_json.reason).toBe('max_hops');
  expect(terminatedEvent[0].payload_json.terminal_handoff_id).toBe('h1');
});

test('emits chain-terminated with reason=untrusted when chain stops at untrusted edge', async () => {
  const cfg = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: [] },
      { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock().mockResolvedValue({
    text: 'go @executor',
    prompt_event_id: 'p', response_event_id: 'r',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const observe = mock().mockResolvedValue({ event_id: 'e' });

  await runAutoChain({
    config: cfg, initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe,
    createHandoff: mock().mockResolvedValue({ handoff_id: 'h-untrusted', status: 'pending' }),
    approve: mock(),
    runChatTurn,
    trustMode: 'config',
  });

  const terminatedEvent = observe.mock.calls.find((c: any) => c[0].event_type === 'chain-terminated');
  expect(terminatedEvent).toBeDefined();
  expect(terminatedEvent[0].payload_json.reason).toBe('untrusted');
  expect(terminatedEvent[0].payload_json.terminal_handoff_id).toBe('h-untrusted');
});

test('emits chain-terminated with reason=error when an exception is thrown mid-chain', async () => {
  const runChatTurn = mock().mockRejectedValue(new Error('crash'));
  const observe = mock().mockResolvedValue({ event_id: 'e' });

  try {
    await runAutoChain({
      config: mockConfig(), initialAgent: 'planner', userMessage: 'hi',
      conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
      observe,
      createHandoff: mock(), approve: mock(), runChatTurn,
    });
  } catch (err) {
    // expected
  }

  const terminatedEvent = observe.mock.calls.find((c: any) => c[0].event_type === 'chain-terminated');
  expect(terminatedEvent).toBeDefined();
  expect(terminatedEvent[0].payload_json.reason).toBe('error');
});

test('chain still terminates cleanly when observe() throws on the chain-terminated emission', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done', prompt_event_id: 'p1', response_event_id: 'r1',
    next_mention: null, mentions: [],
  } as ChatTurnResult);
  
  // Throw ONLY on the terminal event
  const observe = mock().mockImplementation(async (event: any) => {
    if (event.event_type === 'chain-terminated') throw new Error('telemetry down');
    return { event_id: 'e' };
  });

  // Should not throw
  const res = await runAutoChain({
    config: mockConfig(), initialAgent: 'planner', userMessage: 'hi',
    conversation: mockConv, maxHops: 5, transcriptBudget: 1000,
    observe,
    createHandoff: mock(), approve: mock(), runChatTurn,
  });

  expect(res.terminatedReason).toBe('no_mention');
  expect(observe).toHaveBeenCalled();
});
