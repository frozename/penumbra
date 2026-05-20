import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
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
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/watchdog-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

test('WatchdogService fails handoffs for timed-out workers', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const w1 = 'worker-1';
  const w2 = 'worker-2';

  // 1. Seed two handoffs for different workers
  const c1 = await (
    await handoffsCreateRoute(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          from: 'a',
          to: 'b',
          message: 'm',
          conversation_id: 'c1',
          triggered_by_event_id: 'e1',
        }),
      }),
      services,
    )
  ).json();
  const c2 = await (
    await handoffsCreateRoute(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          from: 'a',
          to: 'b',
          message: 'm',
          conversation_id: 'c2',
          triggered_by_event_id: 'e2',
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request('http://x', { method: 'POST', body: '{}' }),
    c1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request('http://x', { method: 'POST', body: '{}' }),
    c2.handoff_id,
    services,
  );

  await handoffsClaimRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w1 }) }),
    c1.handoff_id,
    services,
  );
  await handoffsClaimRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: w2 }) }),
    c2.handoff_id,
    services,
  );

  // 2. Record heartbeats
  watchdog.recordHeartbeat(w1);
  watchdog.recordHeartbeat(w2);

  // 3. Simulate timeout for w1
  (watchdog as any).lastHeartbeats.set(w1, Date.now() - 100_000); // timed out
  (watchdog as any).lastHeartbeats.set(w2, Date.now()); // healthy

  // 4. Tick
  await watchdog.tick();

  // 5. Verify: c1 failed, c2 still dispatched
  const r1 = services.handoffReader.get(c1.handoff_id);
  const r2 = services.handoffReader.get(c2.handoff_id);

  expect(r1?.status).toBe('failed');
  expect(r1?.resolution_reason).toBe('worker timeout');
  expect(r2?.status).toBe('dispatched');

  const allEvents = [
    ...services.dispatchEventLog.listByHandoff(''),
    ...services.dispatchEventLog.listByHandoff(c1.handoff_id),
  ];
  expect(allEvents.some((event) => event.kind === 'watchdog.tick')).toBe(true);
  expect(allEvents.some((event) => event.kind === 'watchdog.auto_fail' && event.handoff_id === c1.handoff_id)).toBe(true);
});

test('WatchdogService emits notification-shaped metadata for timed-out handoffs', async () => {
  const services = tempServices();
  const events: unknown[] = [];
  (services as any).notificationEvents = {
    emit(event: unknown) {
      events.push(event);
    },
  };

  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;

  const worker_id = 'worker-primary';
  const c1 = await (
    await handoffsCreateRoute(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          from: 'a',
          to: 'codex',
          project_id: 'penumbra',
          message: 'm',
          conversation_id: 'c-1',
          triggered_by_event_id: 'e-1',
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request('http://x', { method: 'POST', body: '{}' }),
    c1.handoff_id,
    services,
  );

  await handoffsClaimRoute(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id }) }),
    c1.handoff_id,
    services,
  );

  watchdog.recordHeartbeat(worker_id);
  (watchdog as any).lastHeartbeats.set(worker_id, Date.now() - 100_000);

  await watchdog.tick();

  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    kind: 'watchdog_failure',
    worker_id,
    handoff_id: c1.handoff_id,
    conversation_id: 'c-1',
    project_id: 'penumbra',
    agent: 'codex',
    error_summary: 'worker timeout',
  });
});
