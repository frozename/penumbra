import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { conversationStreamRoute } from '../../src/routes/conversation-stream.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/sse-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
  n: number,
  timeoutMs = 1000,
): Promise<any[]> {
  const reader = stream.getReader();
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(
          () => resolve({ value: undefined, done: true }),
          Math.max(0, deadline - Date.now()),
        ),
      ),
    ]);
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  reader.releaseLock();
  return events;
}

test('GET /conversations/:id/stream flushes cached state and pipes live events', async () => {
  const services = tempServices();
  const cid = 'conv-1';

  // 1. Emit some events BEFORE connecting (will be cached)
  services.conversationStream.emit(cid, { type: 'hop-start', handoff_id: 'h1', agent: 'a1' });
  services.conversationStream.emit(cid, { type: 'token', handoff_id: 'h1', seq: 1, text: 'hello' });

  // 2. Connect
  const res = await conversationStreamRoute(new Request('http://x'), cid, services);
  expect(res.status).toBe(200);

  // 3. Emit live event AFTER connecting
  services.conversationStream.emit(cid, { type: 'token', handoff_id: 'h1', seq: 2, text: ' world' });

  // 4. Read events (should get 2 cached + 1 live)
  const events = await readSseEvents(res.body!, 3);
  expect(events.length).toBe(3);
  expect(events[0]).toEqual({ type: 'hop-start', handoff_id: 'h1', agent: 'a1' });
  expect(events[1]).toEqual({ type: 'token', handoff_id: 'h1', seq: 1, text: 'hello' });
  expect(events[2]).toEqual({ type: 'token', handoff_id: 'h1', seq: 2, text: ' world' });
});

test('GET /conversations/:id/stream clears on hop-end', async () => {
  const services = tempServices();
  const cid = 'conv-1';

  // 1. First hop
  services.conversationStream.emit(cid, { type: 'hop-start', handoff_id: 'h1', agent: 'a1' });
  services.conversationStream.emit(cid, { type: 'hop-end', handoff_id: 'h1', text: 'full' });

  // 2. Connect
  const res = await conversationStreamRoute(new Request('http://x'), cid, services);

  // 3. Should have NO cached events because hop-end cleared them
  const events = await readSseEvents(res.body!, 1, 200);
  expect(events.length).toBe(0);

  // 4. Start second hop
  services.conversationStream.emit(cid, { type: 'hop-start', handoff_id: 'h2', agent: 'a2' });
  const live = await readSseEvents(res.body!, 1);
  expect(live[0]).toEqual({ type: 'hop-start', handoff_id: 'h2', agent: 'a2' });
});

test('GET /conversations/:id/stream isolates by conversation_id', async () => {
  const services = tempServices();
  const r1 = await conversationStreamRoute(new Request('http://x'), 'c1', services);
  const r2 = await conversationStreamRoute(new Request('http://x'), 'c2', services);

  services.conversationStream.emit('c1', { type: 'hop-start', handoff_id: 'h1', agent: 'a' });
  services.conversationStream.emit('c2', { type: 'hop-start', handoff_id: 'h2', agent: 'b' });

  const e1 = await readSseEvents(r1.body!, 1);
  const e2 = await readSseEvents(r2.body!, 1);

  expect(e1[0].handoff_id).toBe('h1');
  expect(e2[0].handoff_id).toBe('h2');
});
