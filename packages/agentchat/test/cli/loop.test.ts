import { expect, test } from 'bun:test';
import { runChatTurn } from '../../src/cli/loop.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { registerAdapter } from '../../src/adapters/registry.js';

const cfg: AgentChatConfig = {
  agents: [
    { name: 'echo', adapter: 'mock-echo', options: {}, roles: ['planner', 'executor'] },
  ],
  default_roles: { planner: 'echo', executor: 'echo' },
};

let eventCounter = 0;
const fakeObserve = async (event: any) => {
  eventCounter++;
  return { event_id: `evt-${eventCounter}` };
};

test('runChatTurn dispatches the planner, observes prompt/response, and returns text + event_ids', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch({ prompt }) { return { text: `echo: ${prompt}` }; },
  }));

  const observed: any[] = [];
  const trackingObserve = async (event: any) => {
    observed.push(event);
    return { event_id: `e-${observed.length}` };
  };

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'hello world',
    conversation: { id: 'c-1', project_id: 'p-1' },
    observe: trackingObserve,
  });

  expect(result.text).toBe('echo: hello world');
  expect(result.next_mention).toBeNull();
  expect(result.prompt_event_id).toBe('e-1');
  expect(result.response_event_id).toBe('e-2');

  expect(observed.length).toBe(2);
  expect(observed[0].event_type).toBe('agent-prompt');
  expect(observed[0].payload_json.prompt).toBe('hello world');
  expect(observed[1].event_type).toBe('agent-response');
  expect(observed[1].payload_json.response).toBe('echo: hello world');
  expect(observed[1].triggered_by_event_id).toBe('e-1');
});

test('runChatTurn captures an adapter throw as an agent-response error event and returns a turn with .error set', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch() { throw new Error('adapter blew up'); },
  }));

  const observed: any[] = [];
  const trackingObserve = async (event: any) => {
    observed.push(event);
    return { event_id: `e-${observed.length}` };
  };

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'go',
    conversation: { id: 'c-err', project_id: null },
    observe: trackingObserve,
  });

  // No throw — the error is conveyed via the result.
  expect(result.error?.message).toMatch(/adapter blew up/);
  expect(result.next_mention).toBeNull();

  // Both events still observed: prompt (success) + response (error payload).
  expect(observed.length).toBe(2);
  expect(observed[0].event_type).toBe('agent-prompt');
  expect(observed[1].event_type).toBe('agent-response');
  expect(observed[1].payload_json.error).toMatch(/adapter blew up/);
  expect(observed[1].triggered_by_event_id).toBe('e-1');
  expect(result.response_event_id).toBe('e-2');
});

test('runChatTurn extracts the first @mention from the response', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch() { return { text: "Plan ready. @executor please run it." }; },
  }));

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'go',
    conversation: { id: 'c-1', project_id: null },
    observe: fakeObserve,
  });
  expect(result.next_mention?.target).toBe('executor');
});