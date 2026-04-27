import { expect, test } from 'bun:test';
import { runAutoChain } from '../../../agentchat/src/cli/auto-loop.js';
import { registerAdapter, clearCustomAdapters } from '../../../agentchat/src/adapters/registry.js';
import type { AgentChatConfig } from '../../../agentchat/src/config/types.js';
import { withDaemon } from '../helpers/with-daemon.js';

test('retry exhaustion marks failed + emits chain-terminated(error) without rejecting', async () => {
  clearCustomAdapters();
  const { client, services, stop } = withDaemon();

  const marker = 'FAIL_ME';
  const errMsg = 'e2e adapter boom';
  let execAttempts = 0;

  const conversation = { id: 'c-retry-e2e', project_id: 'p-retry-e2e' };

  try {
    registerAdapter('e2e-plan-ok', () => ({
      kind: 'e2e-plan-ok',
      async dispatch() {
        return { text: `Plan: do X. @executor ${marker}` };
      },
    }));
    registerAdapter('e2e-exec-flaky', () => ({
      kind: 'e2e-exec-flaky',
      async dispatch({ prompt }) {
        if (prompt.includes(marker)) {
          execAttempts++;
          throw new Error(errMsg);
        }
        return { text: 'ok' };
      },
    }));

    const config: AgentChatConfig = {
      agents: [
        { name: 'planner', adapter: 'e2e-plan-ok', options: {}, roles: ['planner'] },
        { name: 'executor', adapter: 'e2e-exec-flaky', options: {}, roles: ['executor'] },
      ],
      default_roles: {},
    };

    const res = await runAutoChain({
      config,
      initialAgent: 'planner',
      userMessage: 'hi',
      conversation,
      maxHops: 5,
      transcriptBudget: 1000,
      observe: (e) => client.observe(e),
      createHandoff: (body) => client.createHandoff(body),
      approve: (id, body) => client.approve(id, body),
      markFailed: (id, reason) => client.markFailed(id, reason),
      delay: async () => {},
    });

    expect(res.terminatedReason).toBe('error');
    expect(execAttempts).toBe(4);

    const failedHandoffs = services.handoffReader.listByStatus({
      statuses: ['failed'],
      conversation_id: conversation.id,
    });
    expect(failedHandoffs.length).toBe(1);
    expect(failedHandoffs[0].status).toBe('failed');
    expect(failedHandoffs[0].resolution_reason).toBe(errMsg);

    const history = services.chainReader.listHistory(conversation.id);
    const terminated = history.find((e) => e.reason === 'error');
    expect(terminated).toBeDefined();
    expect(terminated?.reason).toBe('error');
  } finally {
    stop();
    clearCustomAdapters();
  }
}, 30_000);
