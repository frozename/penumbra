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

test('runChatTurn dispatches the planner with the user prompt and returns text', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch({ prompt }) { return { text: `echo: ${prompt}` }; },
  }));

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'hello world',
    conversation: { id: 'c-1', project_id: null },
  });

  expect(result.text).toBe('echo: hello world');
  expect(result.next_mention).toBeNull();
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
  });
  expect(result.next_mention?.target).toBe('executor');
});
