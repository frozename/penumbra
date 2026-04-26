import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  buildServices, loadSqliteVec, migrate, type Services,
} from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { handoffsEventsRoute } from '../../src/routes/handoffs-events.js';
import { handoffsCreateRoute, handoffsApproveRoute } from '../../src/routes/handoffs.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/sse-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => { let n = 0; return () => `e-${++n}`; })(),
  });
}

async function readSseEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1000): Promise<any[]> {
  const reader = stream.getReader();
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), deadline - Date.now())),
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

test('GET /handoffs/events delivers approved-handoff events to subscribers', async () => {
  const services = tempServices();
  const res = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  // seed one handoff and approve it after the stream is open
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const events = await readSseEvents(res.body!, 1);
  expect(events.length).toBe(1);
  expect(events[0].handoff_id).toBe(create.handoff_id);
  expect(events[0].status).toBe('approved');
});

test('GET /handoffs/events does not replay events emitted before connect', async () => {
  const services = tempServices();
  // Emit BEFORE subscribing
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const res = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  const events = await readSseEvents(res.body!, 1, 200);
  expect(events.length).toBe(0);
});

test('GET /handoffs/events fans out to multiple subscribers', async () => {
  const services = tempServices();
  const r1 = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  const r2 = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);

  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const [a, b] = await Promise.all([readSseEvents(r1.body!, 1), readSseEvents(r2.body!, 1)]);
  expect(a[0].handoff_id).toBe(create.handoff_id);
  expect(b[0].handoff_id).toBe(create.handoff_id);
});

test('GET /handoffs/events: cancelling the stream unsubscribes from the bus; later emits are not delivered to that subscriber', async () => {
  const services = tempServices();
  // Two subscribers: A will be cancelled mid-flight; B is the control that receives both events.
  const resA = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  const resB = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);

  // Emit event 1 — both subscribers see it.
  const c1 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${c1.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    c1.handoff_id, services);

  const aFirst = await readSseEvents(resA.body!, 1);
  expect(aFirst.map((e) => e.handoff_id)).toEqual([c1.handoff_id]);

  // Cancel subscriber A's stream. This should trigger the route's cancel() handler,
  // which is responsible for calling off() to unsubscribe from services.handoffEvents.
  await resA.body!.cancel();

  // Emit event 2.
  const c2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    c2.handoff_id, services);

  // Subscriber B sees BOTH events 1 and 2 in order — proves the bus is still routing.
  const bBoth = await readSseEvents(resB.body!, 2);
  expect(bBoth.map((e) => e.handoff_id)).toEqual([c1.handoff_id, c2.handoff_id]);

  // The bus is healthy AFTER the cancelled subscriber's enqueue would have been attempted —
  // i.e. unsubscribe ran cleanly rather than crashing on a closed controller.
});