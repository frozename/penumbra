import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { captureWorkflowOutcome } from '../src/capture.js';

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('writes t0 events for run + recall + outcome', () => {
  const db = freshDb();
  captureWorkflowOutcome({
    db, workflowName: 'demo', outcome: 'success', latencyMs: 100,
    artifacts: ['/tmp/x.md'], warnings: [],
    recallSummary: { sources: ['memory.search'], itemCount: 4 },
    project: 'test', sessionId: 's1', userId: 'u', machineId: 'm',
    now: () => new Date('2026-05-04T15:00:00Z'),
  });
  const rows = db.query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts").all() as Array<{ event_type: string }>;
  expect(rows.map((r) => r.event_type)).toEqual(['workflow.run', 'workflow.recall', 'workflow.outcome']);
});

test('upserts workflow_stats incrementing samples + successes', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db, workflowName: 'demo', outcome: 'success', latencyMs: 100,
      artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 },
      project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date(),
    });
  }
  const row = db.query("SELECT samples, successes, failures, consecutive_failures, quarantined FROM workflow_stats WHERE workflow_name='demo'").get() as any;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(3);
  expect(row.failures).toBe(0);
  expect(row.quarantined).toBe(0);
});

test('quarantines after 3 consecutive failures', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db, workflowName: 'flaky', outcome: 'run_error', latencyMs: 50,
      artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 },
      errorMessage: `boom ${i}`,
      project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date(),
    });
  }
  const row = db.query("SELECT consecutive_failures, quarantined, quarantine_reason FROM workflow_stats WHERE workflow_name='flaky'").get() as any;
  expect(row.consecutive_failures).toBe(3);
  expect(row.quarantined).toBe(1);
  expect(row.quarantine_reason).toContain('3 consecutive');
});

test('resets consecutive_failures on success after failures', () => {
  const db = freshDb();
  const args = { db, workflowName: 'recovers', latencyMs: 10, artifacts: [], warnings: [], recallSummary: { sources: [], itemCount: 0 }, project: 't', sessionId: 's', userId: 'u', machineId: 'm', now: () => new Date() };
  captureWorkflowOutcome({ ...args, outcome: 'run_error', errorMessage: 'a' });
  captureWorkflowOutcome({ ...args, outcome: 'run_error', errorMessage: 'b' });
  captureWorkflowOutcome({ ...args, outcome: 'success' });
  const row = db.query("SELECT consecutive_failures, quarantined, samples, successes, failures FROM workflow_stats WHERE workflow_name='recovers'").get() as any;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(1);
  expect(row.failures).toBe(2);
  expect(row.consecutive_failures).toBe(0);
  expect(row.quarantined).toBe(0);
});
