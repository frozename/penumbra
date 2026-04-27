import { expect, test } from 'bun:test';
import { createLogger } from '@penumbra/core';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import { startEventSource } from '../../src/worker/event-source.js';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';
import { registerAdapter, clearCustomAdapters } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { withDaemon } from '../../../e2e/test/helpers/with-daemon.js';

test('--thin path integration: startChain + subscribeConversation', async () => {
  clearCustomAdapters();
  const { client, stop } = withDaemon();

  registerAdapter('thin-test', () => ({
    kind: 'thin-test',
    async dispatch({ prompt }) {
      if (prompt.includes('From @planner')) {
        return { text: 'executor done' };
      }
      return { text: 'plan: @executor go' };
    },
  }));

  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'thin-test', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
      { name: 'executor', adapter: 'thin-test', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: { planner: 'planner', executor: 'executor' },
  };

  const dispatcher = createWorkerDispatcher({
    log: createLogger({ component: 'thin-test-worker' }),
    concurrency: 1,
    claim: (id) => client.claimHandoff(id, 'thin-worker'),
    postProgress: (id, payload) => client.postProgress(id, payload),
    complete: (id) => client.completeHandoff(id),
    dispatch: async (h, onChunk, signal) => {
      const transcript: { agent: string; text: string }[] = [];
      const { handoffs } = await client.listHandoffs({
        statuses: ['completed', 'dispatched', 'approved', 'redirected'],
        conversation_id: h.conversation_id,
      });
      for (const x of [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts))) {
        if (x.handoff_id === h.handoff_id) continue;
        transcript.push({ agent: x.from_agent === 'user' ? 'user' : x.from_agent, text: x.message });
      }
      const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;
      const result = await dispatchHandoff({
        handoff: h, config,
        conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
        transcript, transcriptBudget: 4096,
        hopsSoFar, maxHops: 5,
        trustMode: (h.chain_trust_mode ?? 'all') as 'all' | 'config',
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
        onChunk,
        signal,
      });
      return result;
    },
  });

  const workerEvents = startEventSource({
    client: {
      listHandoffs: (o) => client.listHandoffs(o),
      subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
    },
    statuses: ['approved', 'redirected'],
    pollIntervalMs: 50,
    onEvent: (row) => { void dispatcher.handle(row); },
  });

  try {
    const res = await client.startChain({ initial_agent: 'planner', message: 'go!', max_hops: 5, trust_mode: 'all' });
    
    let tokens = '';
    let ended = false;
    let maxHopsReached = false;
    let hops = 0;

    for await (const event of client.subscribeConversation(res.conversation_id)) {
      console.log('EVENT RECEIVED:', event.type, event.agent_name, event.delta, event.next_handoff_id);
      if (event.type === 'hop-start') hops++;
      if (event.type === 'token') tokens += event.delta;
      if (event.type === 'chain-end') {
        ended = true;
        if (event.reason === 'max_hops') maxHopsReached = true;
        break; // emulate the CLI breaking out of the loop
      } else if (event.type === 'hop-end') {
        if (!event.next_handoff_id) {
          ended = true;
          break;
        }
      }
    }

    expect(ended).toBe(true);
    expect(hops).toBeGreaterThan(0);
    expect(tokens).toContain('executor done');
  } finally {
    await workerEvents.stop();
    await dispatcher.idle();
    stop();
    clearCustomAdapters();
  }
}, 10000);