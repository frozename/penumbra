import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema, enqueueMemoryEfficacyJob, claimNextJob, getJobStatus } from '@penumbra/core';
import { runEfficacyJobReclaimSweep } from '../../src/sweepers/efficacy-job-reclaim.js';
import { startEfficacyJobReclaimSweeper } from '../../src/sweepers/efficacy-job-reclaim.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function setupDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

test('efficacy job reclaim sweeper returns expired running jobs to queued', () => {
  const db = setupDb();
  const services = { db } as any;

  const enqueued = enqueueMemoryEfficacyJob(db, { reviewsDir: '/tmp/reviews' });
  const claimed = claimNextJob(db, '2026-05-01T13:00:00.000Z', {
    workerId: 'worker-a',
    leaseTtlMs: 300_000,
  });
  expect(claimed?.job_id).toBe(enqueued.job_id);

  const reclaimed = runEfficacyJobReclaimSweep({
    services,
    leaseTtlMs: 300_000,
  });
  expect(reclaimed).toContain(enqueued.job_id);

  const status = getJobStatus(db, enqueued.job_id);
  expect(status?.status).toBe('queued');
});

test('efficacy job reclaim sweeper survives a tick failure and unrefs its timer', () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const intervals: Array<() => void> = [];

  globalThis.setInterval = ((fn: () => void) => {
    intervals.push(fn);
    return timer as any;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: any) => {
    expect(handle).toBe(timer);
  }) as typeof clearInterval;

  try {
    const stop = startEfficacyJobReclaimSweeper({
      services: { db: setupDb() } as any,
      log: { info: () => {}, error: () => {} },
      runSweep: () => {
        throw new Error('boom');
      },
    });

    expect(timer.unrefCalled).toBeTrue();
    expect(() => intervals[0]()).not.toThrow();
    stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
