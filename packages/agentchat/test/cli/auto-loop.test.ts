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
