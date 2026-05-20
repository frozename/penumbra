import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, createLogger, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '../../../daemon/test-utils.ts';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';
import { startEventSource } from '../../src/worker/event-source.js';
import { registerAdapter, clearCustomAdapters } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  /* already loaded */
}

test('PHASE 2 — two workers race to claim the same approved handoff; claimDispatch ensures exactly one wins', async () => {
  clearCustomAdapters();
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-race-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services: Services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  services.agentRegistry = ['planner', 'executor', 'a', 'b', 'claude-mem'];
  services.watchdog.hasActiveWorker = () => true;
  const handle = serve({ services, token: 'tok', port: 0 });
  services.watchdog.recordHeartbeat('test-worker');
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');

  let dispatchCount = 0;
  registerAdapter('mock-race', () => ({
    kind: 'mock-race',
    async dispatch() {
      dispatchCount++;
      return { text: 'ok' };
    },
  }));

  const config: AgentChatConfig = {
    agents: [{ name: 'a', adapter: 'mock-race', options: {}, roles: ['a'], auto_approve_to: [] }],
    default_roles: {},
  };

  const client = new PenumbraClient({ storageRoot: dir });

  const makeWorker = (id: string) => {
    const dispatcher = createWorkerDispatcher({
      log: createLogger({ component: id }),
      concurrency: 1,
      claim: (hid) => client.claimHandoff(hid, id),
      postProgress: (hid, payload) => client.postProgress(hid, payload),
      complete: (id) => client.completeHandoff(id),
      dispatch: async (h) => {
        const result = await dispatchHandoff({
          handoff: h,
          config,
          conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
          transcript: [],
          transcriptBudget: 4096,
          hopsSoFar: 0,
          maxHops: 5,
          trustMode: 'all',
          observe: (e) => client.observe(e),
          createHandoff: (body) => client.createHandoff(body),
          approve: (hid2, body) => client.approve(hid2, body),
        });
        return result;
      },
    });
    const es = startEventSource({
      client: {
        listHandoffs: (o) => client.listHandoffs(o),
        subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
      },
      statuses: ['approved', 'redirected'],
      pollIntervalMs: 10,
      onEvent: (row) => {
        void dispatcher.handle(row);
      },
    });
    return { dispatcher, es };
  };

  const w1 = makeWorker('worker-1');
  const w2 = makeWorker('worker-2');

  try {
    // 1. Create an approved handoff
    const start = await client.startChain({ initial_agent: 'a', message: 'go' });

    // 2. Wait for both workers to see it and try to claim it
    await new Promise((r) => setTimeout(r, 500));

    // 3. Verify: only ONE dispatch occurred
    expect(dispatchCount).toBe(1);

    // 4. Verify DB state: handoff should be completed (by the winner)
    const row = services.handoffReader.get(start.handoff_id);
    expect(row?.status).toBe('completed');
    expect(row?.worker_id).toMatch(/worker-[12]/);
  } finally {
    await w1.es.stop();
    await w2.es.stop();
    await w1.dispatcher.idle();
    await w2.dispatcher.idle();
    handle.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    clearCustomAdapters();
  }
}, 15000);
