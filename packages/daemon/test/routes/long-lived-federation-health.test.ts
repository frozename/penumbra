import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { longLivedFederationHealthRoute } from '../../src/routes/long-lived-federation-health.js';

function makeServices(db: Database): Services {
  return {
    db,
    settings: {},
    storageRoot: '/tmp/penumbra-test',
    dbMeta: {} as any,
    machineId: { get: () => 'machine-test' } as any,
    projectCache: {} as any,
    redactor: {} as any,
    t0Writer: {} as any,
    handoffWriter: {} as any,
    recallReader: {} as any,
    handoffReader: {} as any,
    chainReader: {} as any,
    handoffEvents: {} as any,
    permissionWriter: {} as any,
    permissionReader: {} as any,
    permissionEvents: {} as any,
    dispatchEventLog: {} as any,
    dispatchEvents: {} as any,
    conversationStream: {} as any,
    workerControl: {} as any,
    worktreeManager: {} as any,
    watchdog: {} as any,
    supervisor: {} as any,
    pidRegistry: {} as any,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-11T00:00:00.000Z'),
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    log: { info: () => {}, warn: () => {}, error: () => {} } as any,
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
    subscriptionPressureCache: {} as any,
    planWriter: {} as any,
  } as Services;
}

test('GET /long-lived/federation-health returns process-wide federation snapshot', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.mcpPool = {
    getFederationHealth: () => ({
      registered: [{ server: 'alpha', tool: 'state_get', name: 'alpha:state_get' }],
      skipped: [{ server: 'beta', tool: 'beta', reason: 'tools_unavailable' }],
    }),
  } as any;

  const res = await longLivedFederationHealthRoute(new Request('http://x/long-lived/federation-health'), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    registered: [{ server: 'alpha', tool: 'state_get', name: 'alpha:state_get' }],
    skipped: [{ server: 'beta', tool: 'beta', reason: 'tools_unavailable' }],
  });
});
