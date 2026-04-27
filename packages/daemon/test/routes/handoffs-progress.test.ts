import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services,
  migrate,
  loadSqliteVec,
  HandoffWriter,
  HandoffReader,
  ConversationStreamBus,
} from '@penumbra/core';
import { handoffsCreateRoute } from '../../src/routes/handoffs.js';
import { handoffsProgressRoute } from '../../src/routes/handoffs-progress.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  /* already loaded */
}

function makeServices(db: Database): Services {
  const handoffEvents = { subscribe: () => {}, emit: () => {} };
  const conversationStream = new ConversationStreamBus();
  return {
    db,
    handoffWriter: new HandoffWriter({ db, events: handoffEvents as any }),
    handoffReader: new HandoffReader({ db }),
    conversationStream,
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    clock: () => new Date('2026-04-25T20:00:00.000Z'),
    t0Writer: { write: () => {} },
    machineId: { get: () => 'machine-test' },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  } as unknown as Services;
}

test('POST /handoffs/:id/progress resolves conversation_id and emits to stream', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // 1. Seed a handoff
  const createRes = await handoffsCreateRoute(
    new Request('http://x/handoffs', {
      method: 'POST',
      body: JSON.stringify({
        from: 'claude',
        to: 'gemini',
        message: 'go',
        conversation_id: 'conv-123',
        triggered_by_event_id: 'e1',
      }),
    }),
    services,
  );
  const { handoff_id } = await createRes.json();

  // 2. Push hop-start
  const startReq = new Request(`http://x/handoffs/${handoff_id}/progress`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'hop-start',
      handoff_id,
      chain_id: 'conv-123',
      idx: 0,
      agent_name: 'gemini',
      status: 'in_progress',
    }),
  });
  await handoffsProgressRoute(startReq, handoff_id, services);

  // 3. Push token
  const progressReq = new Request(`http://x/handoffs/${handoff_id}/progress`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'token',
      handoff_id,
      seq: 1,
      delta: 'hello',
    }),
  });

  let emittedConv: string | null = null;
  let emittedEvent: any = null;
  services.conversationStream.subscribe((convId, event) => {
    emittedConv = convId;
    emittedEvent = event;
  });

  const progressRes = await handoffsProgressRoute(progressReq, handoff_id, services);
  expect(progressRes.status).toBe(200);

  // 4. Verify emission
  expect(emittedConv).toBe('conv-123');
  expect(emittedEvent).toEqual({
    type: 'token',
    handoff_id,
    seq: 1,
    delta: 'hello',
  });

  // 5. Verify cache
  const history = services.conversationStream.getHistory('conv-123');
  expect(history).toContainEqual(emittedEvent);
});

test('POST /handoffs/:id/progress accepts terminal handoff progress and emits to stream', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // 1. Seed and complete a handoff
  const handoff_id = 'h1';
  services.handoffWriter.createApproved({
    handoff_id,
    ts: 't',
    project_id: null,
    conversation_id: 'c1',
    from: 'a',
    to: 'b',
    to_role: null,
    message: 'm',
    triggered_by_event_id: 'e1',
    resolved_by: 'u1',
    resolved_at: 't',
    chain_max_hops: null,
    chain_trust_mode: null,
  });
  services.handoffWriter.claimDispatch(handoff_id, 'w1');
  services.handoffWriter.markCompleted(handoff_id);

  let emittedConv: string | null = null;
  let emittedEvent: any = null;
  services.conversationStream.subscribe((convId, event) => {
    emittedConv = convId;
    emittedEvent = event;
  });

  // 2. Push progress
  const res = await handoffsProgressRoute(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ type: 'token', handoff_id, seq: 1, delta: '...' }),
    }),
    handoff_id,
    services,
  );
  expect(res.status).toBe(200);
  expect(emittedConv).toBe('c1');
  expect(emittedEvent).toEqual({ type: 'token', handoff_id, seq: 1, delta: '...' });
});

test('POST /handoffs/:id/progress accepts merge-result progress for all statuses', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoff_id = 'h-merge';
  services.handoffWriter.createApproved({
    handoff_id,
    ts: 't',
    project_id: null,
    conversation_id: 'c-merge',
    from: 'a',
    to: 'b',
    to_role: null,
    message: 'm',
    triggered_by_event_id: 'e1',
    resolved_by: 'u1',
    resolved_at: 't',
    chain_max_hops: null,
    chain_trust_mode: null,
  });

  const cases = [
    { status: 'merged' as const },
    { status: 'rebased' as const },
    { status: 'rebase_conflict' as const, conflict_files: ['src/a.ts'], worktree_dirty: true },
    { status: 'test_failed' as const, regression_summary: 'tests failed', timed_out: true },
    { status: 'typecheck_failed' as const, regression_summary: 'typecheck failed', timed_out: false },
  ];

  for (const body of cases) {
    const res = await handoffsProgressRoute(
      new Request('http://x/handoffs/h-merge/progress', {
        method: 'POST',
        body: JSON.stringify({
          type: 'merge-result',
          handoff_id,
          ...body,
        }),
      }),
      handoff_id,
      services,
    );
    expect(res.status).toBe(200);
  }
});

test('POST /handoffs/:id/progress returns 404 for unknown handoff', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsProgressRoute(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ type: 'token', handoff_id: 'h-nope', seq: 1, delta: '...' }),
    }),
    'h-nope',
    services,
  );
  expect(res.status).toBe(404);
});

test('POST /handoffs/:id/progress returns 400 for invalid event', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsProgressRoute(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ type: 'garbage' }),
    }),
    'h1',
    services,
  );
  expect(res.status).toBe(400);
});
