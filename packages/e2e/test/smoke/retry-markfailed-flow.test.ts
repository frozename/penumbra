import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '@penumbra/daemon/src/serve.js';
import { runAutoChain } from '../../../agentchat/src/cli/auto-loop.js';
import { registerAdapter, clearCustomAdapters } from '../../../agentchat/src/adapters/registry.js';
import { PenumbraClient } from '../../../agentchat/src/penumbra-client.js';
import type { AgentChatConfig } from '../../../agentchat/src/config/types.js';

function withDaemon(): {
  client: PenumbraClient;
  services: Services;
  stop: () => void;
} {
  const storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-e2e-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  }) as any;

  writeFileSync(join(storageRoot, 'port'), '1\n');
  writeFileSync(join(storageRoot, 'token'), `${token}\n`);

  return {
    client: new PenumbraClient({ storageRoot, fetch: fetchImpl }),
    services,
    stop() {
      try { services.supervisor.stopAll(); } catch {}
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

test('retry exhaustion marks failed + emits chain-terminated(error) without rejecting', async () => {
  clearCustomAdapters();
  const { client, services, stop } = withDaemon();

  const marker = 'FAIL_ME';
  const errMsg = 'e2e adapter boom';
  let execAttempts = 0;

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
      conversation: { id: 'c-retry-e2e', project_id: 'p-retry-e2e' },
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

    const failed = services.db.query<any, []>(
      `SELECT status, resolution_reason FROM handoffs WHERE status='failed'`,
    ).get();
    expect(failed).toBeDefined();
    expect(failed.status).toBe('failed');
    expect(failed.resolution_reason).toBe(errMsg);

    const terminated = services.db.query<any, []>(
      `SELECT payload_json FROM t0_events WHERE event_type='chain-terminated'`,
    ).get();
    expect(terminated).toBeDefined();
    const payload = JSON.parse(terminated.payload_json);
    expect(payload.reason).toBe('error');
  } finally {
    stop();
    clearCustomAdapters();
  }
}, 30_000);
