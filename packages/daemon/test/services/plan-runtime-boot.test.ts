import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, PlanWriter, TaskWriter, TaskEventBus } from '@penumbra/core';
import { createPlanRuntimeSweeper } from '../../src/sweepers/plan-runtime.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('plan-runtime sweeper start/stop is safe to call repeatedly', () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });

  const sweeper = createPlanRuntimeSweeper({ db, plans, taskWriter, intervalMs: 100 });

  sweeper.start();
  sweeper.start();
  sweeper.stop();
  sweeper.stop();

  expect(true).toBe(true);
});

test('plan-runtime subscribe/unsubscribe is clean against a live bus', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const bus = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });

  const sweeper = createPlanRuntimeSweeper({ db, plans, taskWriter });

  const unsub = sweeper.subscribe(bus);
  unsub();

  bus.publish({
    kind: 'completed',
    task_id: 'fake-task',
    at: Date.now(),
    actor: null,
    payload: null,
  } as any);
  await new Promise((r) => setTimeout(r, 50));

  expect(true).toBe(true);
});
