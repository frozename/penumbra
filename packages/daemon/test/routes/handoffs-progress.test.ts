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

  // 2. Push progress
  const progressReq = new Request(`http://x/handoffs/${handoff_id}/progress`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'token',
      handoff_id,
      seq: 1,
      text: 'hello',
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

  // 3. Verify emission
  expect(emittedConv).toBe('conv-123');
  expect(emittedEvent).toEqual({
    type: 'token',
    handoff_id,
    seq: 1,
    text: 'hello',
  });

  // 4. Verify cache
  const history = services.conversationStream.getHistory('conv-123');
  expect(history).toContainEqual(emittedEvent);
});

test('POST /handoffs/:id/progress returns 404 for unknown handoff', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsProgressRoute(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ type: 'token', handoff_id: 'h-nope', seq: 1, text: '...' }),
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
