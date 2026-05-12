import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '../../../core/src/db/schema.js';
import { enqueueMemoryEfficacyJob, claimNextJob, getJobStatus } from '../../../core/src/readers/memory-efficacy-jobs.js';
import { runEfficacyJobReclaimSweep } from '../../src/sweepers/efficacy-job-reclaim.js';

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
