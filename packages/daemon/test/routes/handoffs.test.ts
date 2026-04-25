import { expect, test } from 'bun:test';
import { handoffsCreateRoute } from '../../src/routes/handoffs.js';
import { type Services, migrate, loadSqliteVec, HandoffWriter, HandoffReader } from '@penumbra/core';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

function makeServices(db: Database): Services {
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  return {
    db,
    handoffWriter: writer,
    handoffReader: reader,
    machineId: { get: () => 'machine-test' },
    uuid: () => 'evt-fixed-1',
    clock: () => new Date('2026-04-25T20:00:00.000Z'),
    t0Writer: { write: () => {} },
    redactor: { redact: (s: unknown) => s },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

test('POST /handoffs creates a pending handoff and returns the id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude',
      to: 'gemini',
      to_role: 'executor',
      message: 'go',
      conversation_id: 'conv-7',
      project_id: 'auth-svc',
      triggered_by_event_id: 'evt-source-1',
    }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('pending');
  expect(typeof body.handoff_id).toBe('string');

  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM handoffs WHERE handoff_id=?',
  ).get(body.handoff_id);
  expect(row?.status).toBe('pending');
});

test('POST /handoffs returns 400 for invalid body', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({ from: 'claude' }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(400);
});
