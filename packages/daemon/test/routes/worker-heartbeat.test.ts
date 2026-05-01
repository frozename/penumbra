import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { workerHeartbeatRoute } from '../../src/routes/worker-heartbeat.js';
import { WatchdogService } from '../../src/services/watchdog.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/sqlite3.dylib');
  }
} catch {
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/heartbeat-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

test('POST /worker/heartbeat returns 200 and records heartbeat', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const req = new Request('http://x/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ worker_id: 'test-worker-1' }),
  });
  const res = await workerHeartbeatRoute(req, services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const map = (watchdog as any).lastHeartbeats as Map<string, number>;
  expect(map.has('test-worker-1')).toBe(true);
  expect(services.dispatchEventLog.listByHandoff('').some((event) => (
    event.kind === 'heartbeat.received' && event.worker_id === 'test-worker-1'
  ))).toBe(true);
});

test('POST /worker/heartbeat returns 400 on missing fields', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const req = new Request('http://x/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ wrong_field: 'test' }),
  });
  const res = await workerHeartbeatRoute(req, services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe('validation_error');
});

test('POST /worker/heartbeat is idempotent for same worker', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  // First heartbeat
  const req1 = new Request('http://x/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ worker_id: 'test-worker-2' }),
  });
  await workerHeartbeatRoute(req1, services);
  
  const map = (watchdog as any).lastHeartbeats as Map<string, number>;
  const time1 = map.get('test-worker-2');
  
  // Wait a tiny bit to ensure time changes
  await new Promise(resolve => setTimeout(resolve, 5));

  const req2 = new Request('http://x/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ worker_id: 'test-worker-2' }),
  });
  await workerHeartbeatRoute(req2, services);

  expect(map.size).toBe(1);
  const time2 = map.get('test-worker-2');
  expect(time2).toBeGreaterThanOrEqual(time1!);
});
