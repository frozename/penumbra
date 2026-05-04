import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { computeStateMetrics } from '../src/poller.js';

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('computeStateMetrics returns zeros on empty db', () => {
  const db = freshDb();
  const m = computeStateMetrics({ db, now: () => new Date('2026-05-04T12:00:00Z') });
  expect(m['pending-handoffs']).toBe(0);
});

test('counts pending handoffs and computes queue-idle-min from latest dispatch.end', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-04T11:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending');

    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES (1, 'h1', 'worker', 'dispatch.end', '2026-05-04T11:30:00Z', '{}');
  `);

  const m = computeStateMetrics({ db, now: () => new Date('2026-05-04T12:00:00Z') });
  expect(m['pending-handoffs']).toBe(1);
  expect(m['queue-idle-min']).toBe(30);
});
