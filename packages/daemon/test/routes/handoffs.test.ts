import { expect, test } from 'bun:test';
import {
  handoffsCreateRoute,
  handoffsListPendingRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
  handoffsCompleteRoute,
  handoffsFailRoute,
} from '../../src/routes/handoffs.js';
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
    uuid: (() => { let n = 0; return () => `evt-${++n}`; })(),
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

test('GET /handoffs/pending returns pending handoffs', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  // seed via the create route
  await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  }), services);

  const res = await handoffsListPendingRoute(
    new Request('http://x/handoffs/pending'), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('POST /handoffs/:id/approve flips to approved', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, { method: 'POST', body: '{}' }),
    id, services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('approved');
});

test('POST /handoffs/:id/approve returns 409 if already resolved', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  const second = await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  expect(second.status).toBe(409);
});

test('POST /handoffs/:id/approve accepts optional resolved_by override', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ resolved_by: 'auto' }),
    }),
    id, services,
  );
  expect(res.status).toBe(200);

  const row = db.query<{ resolved_by: string | null }, [string]>(
    'SELECT resolved_by FROM handoffs WHERE handoff_id=?',
  ).get(id);
  expect(row?.resolved_by).toBe('auto');
});

test('GET /handoffs?status=approved returns only approved rows', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // seed two handoffs
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);
  const created2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    created2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=approved`), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].handoff_id).toBe(created2.handoff_id);
  expect(body.handoffs[0].status).toBe('approved');
});

test('GET /handoffs?status=pending,approved returns both', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const c1 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  const c2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    c2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=pending,approved`), services,
  );
  const body = await res.json();
  const ids = body.handoffs.map((h: any) => h.handoff_id).sort();
  expect(ids).toEqual([c1.handoff_id, c2.handoff_id].sort());
});

test('GET /handoffs without status param defaults to pending (back-compat)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs`), services,
  );
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('GET /handoffs?status=garbage returns 400', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=garbage`), services,
  );
  expect(res.status).toBe(400);
});

async function seedApproveClaim(services: Services): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), create.handoff_id, services);
  return create.handoff_id;
}

test('POST /handoffs/<id>/complete flips dispatched → completed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'completed' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('completed');
});

test('POST /handoffs/<id>/complete on a pending handoff returns 409', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), create.handoff_id, services);
  expect(res.status).toBe(409);
});

test('POST /handoffs/<id>/complete on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), 'h-nope', services);
  expect(res.status).toBe(404);
});

async function seedAndApprove(services: Services): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  return create.handoff_id;
}

test('POST /handoffs/<id>/claim flips approved → dispatched and returns 200', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services);

  const res = await handoffsClaimRoute(new Request(`http://x/handoffs/${id}/claim`, { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'dispatched' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim a second time returns 409 with current_status', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);

  const second = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);
  expect(second.status).toBe(409);
  const body = await second.json();
  expect(body.current_status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), 'h-nope', services);
  expect(res.status).toBe(404);
});

test('POST /handoffs/<id>/claim on a pending handoff returns 409 (not approved)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), create.handoff_id, services);
  expect(res.status).toBe(409);
});

test('POST /handoffs/<id>/fail flips pending → failed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'testing failure' }),
  }), create.handoff_id, services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: create.handoff_id, status: 'failed' });
  
  const row = db.query<{ status: string; resolution_reason: string | null }, [string]>(
    'SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?',
  ).get(create.handoff_id);
  expect(row?.status).toBe('failed');
  expect(row?.resolution_reason).toBe('testing failure');
});

test('POST /handoffs/<id>/fail returns 400 for missing/empty reason', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  
  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: '' }),
  }), 'some-id', services);
  expect(res.status).toBe(400);

  const res2 = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({}),
  }), 'some-id', services);
  expect(res2.status).toBe(400);
});

test('POST /handoffs/<id>/fail returns 404 for unknown id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  
  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'oops' }),
  }), 'h-nope', services);
  expect(res.status).toBe(404);
});

test('POST /handoffs/<id>/fail returns 409 if already terminal', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);
  await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);

  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'too late' }),
  }), id, services);
  
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.current_status).toBe('completed');
});
