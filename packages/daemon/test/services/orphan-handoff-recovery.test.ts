import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { OrphanHandoffRecoveryService } from '../../src/services/orphan-handoff-recovery.js';
import { WatchdogService } from '../../src/services/watchdog.js';
import {
  handoffsCreateRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
} from '../../src/routes/handoffs.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/sqlite3.dylib');
  }
} catch {
  // ignore
}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/orphan-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-20T00:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  return services;
}

test('OrphanHandoffRecoveryService requeues when attempts < max', async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 }); // 0 ms means everything is stale
  
  const w1 = 'dead-worker-1';
  
  const c1 = await (await handoffsCreateRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c', triggered_by_event_id: 'e', max_dispatch_attempts: 3 }) }),
    services,
  )).json();
  
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c1.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w1 }) }), c1.handoff_id, services);
  
  services.watchdog.recordHeartbeat(w1);
  await new Promise(r => setTimeout(r, 1)); // Ensure Date.now() is slightly later
  
  const result = recovery.runOnce();
  expect(result).toEqual({ requeued: 1, exhausted: 0 });
  
  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe('approved');
  expect(row?.worker_id).toBeNull();
  expect(row?.dispatch_attempts).toBe(1);
  
  const events = services.dispatchEventLog.listByHandoff(c1.handoff_id);
  expect(events.some(e => e.kind === 'worker.recovery.requeued')).toBe(true);
});

test('OrphanHandoffRecoveryService fails when attempts == max', async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });
  
  const w1 = 'dead-worker-1';
  
  const c1 = await (await handoffsCreateRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c', triggered_by_event_id: 'e' }) }),
    services,
  )).json();
  services.db.query('UPDATE handoffs SET max_dispatch_attempts=1 WHERE handoff_id=?').run(c1.handoff_id);
  
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c1.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w1 }) }), c1.handoff_id, services);
  
  services.watchdog.recordHeartbeat(w1);
  await new Promise(r => setTimeout(r, 1));
  
  const result = recovery.runOnce();
  expect(result).toEqual({ requeued: 0, exhausted: 1 });
  
  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe('failed');
  expect(row?.resolution_reason).toContain('failed_worker_restart');
  
  const events = services.dispatchEventLog.listByHandoff(c1.handoff_id);
  expect(events.some(e => e.kind === 'worker.recovery.exhausted')).toBe(true);
});

test('OrphanHandoffRecoveryService CAS race avoids double action', async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });
  
  const w1 = 'dead-worker-1';
  const c1 = await (await handoffsCreateRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c', triggered_by_event_id: 'e' }) }),
    services,
  )).json();
  
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c1.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w1 }) }), c1.handoff_id, services);
  
  services.watchdog.recordHeartbeat(w1);
  await new Promise(r => setTimeout(r, 1));
  
  const orphans = services.handoffReader.listOrphanedDispatches([w1]);
  services.handoffWriter.requeueOrphanedDispatch(c1.handoff_id, w1);
  
  let requeued = 0;
  for (const orphan of orphans) {
     const won = services.handoffWriter.requeueOrphanedDispatch(orphan.handoff_id, orphan.worker_id);
     if (won) requeued++;
  }
  expect(requeued).toBe(0); // already requeued above
});

test('OrphanHandoffRecoveryService ignores fresh workers', async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 90000 });
  
  const w1 = 'fresh-worker-1';
  const c1 = await (await handoffsCreateRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c', triggered_by_event_id: 'e' }) }),
    services,
  )).json();
  
  await handoffsApproveRoute(new Request('http://x', { method: 'POST', body: '{}' }), c1.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w1 }) }), c1.handoff_id, services);
  
  services.watchdog.recordHeartbeat(w1);
  
  const result = recovery.runOnce();
  expect(result).toEqual({ requeued: 0, exhausted: 0 });
  
  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe('dispatched'); // untouched
});
