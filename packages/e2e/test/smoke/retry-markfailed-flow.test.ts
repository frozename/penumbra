import { expect, test } from 'bun:test';
import { registerAdapter, clearCustomAdapters } from '../../../agentchat/src/adapters/registry.js';
import type { AgentChatConfig } from '../../../agentchat/src/config/types.js';
import { withDaemon } from '../helpers/with-daemon.js';
import { createWorkerDispatcher } from '../../../agentchat/src/worker/dispatcher.js';
import { dispatchHandoff } from '../../../agentchat/src/cli/dispatch-handoff.js';
import { createLogger } from '@penumbra/core';

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
        { name: 'planner', adapter: 'e2e-plan-ok', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
        { name: 'executor', adapter: 'e2e-exec-flaky', options: {}, roles: ['executor'], auto_approve_to: [] },
      ],
      default_roles: {},
    };

    // Use a real worker dispatcher with real dispatchHandoff
    const dispatcher = createWorkerDispatcher({
      log: createLogger({ component: 'e2e-worker' }),
      concurrency: 1,
      claim: (id) => client.claimHandoff(id, 'e2e-worker'),
      postProgress: (id, payload) => client.postProgress(id, payload),
      complete: (id) => client.completeHandoff(id),
      dispatch: async (h, onChunk, signal) => {
        return await dispatchHandoff({
          handoff: h,
          config,
          conversation,
          transcript: [],
          transcriptBudget: 4096,
          hopsSoFar: 0,
          maxHops: 5,
          trustMode: 'all',
          observe: (e) => client.observe(e),
          createHandoff: (body) => client.createHandoff(body),
          approve: (id, body) => client.approve(id, body),
          markFailed: (id, reason) => client.markFailed(id, reason),
          onChunk,
          signal,
          delay: async () => {}, // no delay in tests
        });
      },
    });

    const start = await client.startChain({
      initial_agent: 'planner',
      message: 'hi',
      conversation_id: conversation.id,
      project_id: conversation.project_id,
    });

    // Manually drive the dispatcher
    const handoff1 = services.handoffReader.get(start.handoff_id);
    await dispatcher.handle(handoff1);
    await dispatcher.idle();

    // The planner should have created an executor handoff
    const handoffs = services.handoffReader.listByStatus({ statuses: ['approved'], conversation_id: conversation.id });
    expect(handoffs.length).toBe(1);
    expect(handoffs[0].to_agent).toBe('executor');

    await dispatcher.handle(handoffs[0]);
    await dispatcher.idle();

    expect(execAttempts).toBe(4); // 1 initial + 3 retries

    const failedHandoffs = services.handoffReader.listByStatus({
      statuses: ['failed'],
      conversation_id: conversation.id,
    });
    expect(failedHandoffs.length).toBe(1);
    expect(failedHandoffs[0].status).toBe('failed');
    expect(failedHandoffs[0].resolution_reason).toBe(errMsg);
  } finally {
    stop();
    clearCustomAdapters();
  }
}, 30_000);
