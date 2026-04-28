import { expect, test, mock } from 'bun:test';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import type { ChatTurnResult } from '../../src/cli/loop.js';
import type { WriteToolsExecutor } from '../../src/worker/write-tools-executor.js';

const mockConv = { id: 'c1', project_id: null };
const cfg = {
  agents: [
    { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
    { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
  ],
  default_roles: {},
};
const baseHandoff = {
  handoff_id: 'h0', ts: 't', project_id: null, conversation_id: 'c1',
  from_agent: 'user', to_agent: 'planner', to_role: null, message: 'hi',
  status: 'approved', resolved_by: null, resolved_at: null, redirected_to: null,
  triggered_by_event_id: null, chain_max_hops: null, chain_trust_mode: null,
};

const stubExecutor = { id: 'exec-stub' } as unknown as WriteToolsExecutor;

test('chain-start handoff (from=user) sends raw message, no transcript wrap', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(res.terminatedReason).toBe('no_mention');
  expect(res.next).toBeNull();
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe('planner');
  expect(call.prompt).toBeUndefined(); // raw message via userMessage path
  expect(call.userMessage).toBe('hi');
});

test('continuation handoff wraps transcript via buildNextPrompt', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ok', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const continuation = { ...baseHandoff, handoff_id: 'h1', from_agent: 'planner', to_agent: 'executor', message: 'do the thing' };
  await dispatchHandoff({
    handoff: continuation,
    config: cfg,
    conversation: mockConv,
    transcript: [{ agent: 'user', text: 'hi' }, { agent: 'planner', text: 'do the thing' }],
    transcriptBudget: 1000,
    hopsSoFar: 1,
    maxHops: 5,
    trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe('executor');
  expect(call.prompt).toContain('From @planner: do the thing');
  expect(call.prompt).toContain('[user]: hi');
});

test('mention triggers handoff create + approve when trustMode=all', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-next', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(createHandoff.mock.calls[0]![0]).toMatchObject({ from: 'planner', to: 'executor' });
  expect(approve).toHaveBeenCalledWith('h-next', { resolved_by: 'auto' });
  expect(res.terminatedReason).toBeUndefined();
  expect(res.next?.handoff_id).toBe('h-next');
});

test('mention with trustMode=config + edge in auto_approve_to → approves', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h2', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'config',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(approve).toHaveBeenCalled();
  expect(res.terminatedReason).toBeUndefined();
});

test('mention with trustMode=config + edge NOT in auto_approve_to → leaves pending, returns untrusted', async () => {
  const cfgNoTrust = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: [] },
      { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-untrusted', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfgNoTrust, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'config',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe('untrusted');
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBe('h-untrusted');
});

test('hopsSoFar+1 >= maxHops → creates handoff but does not approve, returns max_hops', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'go @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-cap', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 4, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe('max_hops');
  expect(res.cappedHandoffId).toBe('h-cap');
});

test('runChatTurn error retries and eventually succeeds (no markFailed)', async () => {
  const runChatTurn = mock()
    .mockResolvedValueOnce({
      text: '', prompt_event_id: 'p1', response_event_id: 'r1',
      next_mention: null, mentions: [],
      error: { message: 'adapter blew up' },
    } as ChatTurnResult)
    .mockResolvedValueOnce({
      text: '', prompt_event_id: 'p2', response_event_id: 'r2',
      next_mention: null, mentions: [],
      error: { message: 'adapter blew up again' },
    } as ChatTurnResult)
    .mockResolvedValueOnce({
      text: 'done', prompt_event_id: 'p3', response_event_id: 'r3',
      next_mention: null, mentions: [],
    } as ChatTurnResult);

  const createHandoff = mock();
  const markFailed = mock();
  const delay = mock().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve: mock(), runChatTurn, markFailed, delay,
  });

  expect(res.terminatedReason).toBe('no_mention');
  expect(res.next).toBeNull();
  expect(createHandoff).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(3);
  expect(delay.mock.calls.map((c: any) => c[0])).toEqual([200, 400]);
});

test('runChatTurn error exhausts retries → markFailed then throws', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: '', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
    error: { message: 'adapter blew up' },
  } as ChatTurnResult);
  const createHandoff = mock();
  const markFailed = mock().mockResolvedValue({ handoff_id: 'h0', status: 'failed' });
  const delay = mock().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve: mock(), runChatTurn, markFailed, delay,
  });

  expect(res.terminatedReason).toBe('error');
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBe('h0');
  expect(createHandoff).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(4);
  expect(delay.mock.calls.map((c: any) => c[0])).toEqual([200, 400, 800]);
  expect(markFailed).toHaveBeenCalledTimes(1);
  expect(markFailed).toHaveBeenCalledWith('h0', 'adapter blew up');
});

test('projectContext is threaded through to buildNextPrompt for continuation hops', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ok', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const continuation = { ...baseHandoff, handoff_id: 'h1', from_agent: 'planner', to_agent: 'executor', message: 'do' };
  await dispatchHandoff({
    handoff: continuation, config: cfg, conversation: mockConv,
    transcript: [{ agent: 'user', text: 'hi' }],
    transcriptBudget: 1000,
    hopsSoFar: 1, maxHops: 5, trustMode: 'all',
    projectContext: 'PROJECT-CTX-MARKER',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(), approve: mock(), runChatTurn,
  });
  expect(runChatTurn.mock.calls[0]![0].prompt).toContain('PROJECT-CTX-MARKER');
});

test('executor opt is forwarded to runChatTurn', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: 'all',
    executor: stubExecutor,
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(runChatTurn.mock.calls[0]![0].executor).toBe(stubExecutor);
});
