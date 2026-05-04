import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { runDispatchEventsSource } from '../../src/recall-sources/dispatch.js';
import { runHandoffPendingSource } from '../../src/recall-sources/handoff.js';

test('dispatch_events filters by since', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.exec(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h1', 'worker', 'dispatch.start', '2026-05-04T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'dispatch.end',   '2026-05-04T10:01:00Z', '{}'),
      (3, 'h2', 'worker', 'dispatch.start', '2026-05-04T11:00:00Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { since: '2026-05-04T10:30:00Z' } });
  expect(out.events.map((e) => e.id)).toEqual([3]);
  expect(out.warnings).toEqual([]);
});

test('handoff.list_pending returns pending only', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', 'c1', 'a', 'b', 'msg2', 'completed');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(['h1']);
  expect(out.warnings).toEqual([]);
});
