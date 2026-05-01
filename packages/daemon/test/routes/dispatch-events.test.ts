import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, loadSqliteVec, type Services } from '@penumbra/core';
import { createDaemonFetchHandler } from '../../src/serve.js';
import { dispatchEventsGetRoute, dispatchEventsPostRoute } from '../../src/routes/dispatch-events.js';

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  return buildServices({ env: {}, input: {}, storageRoot: '/tmp/dispatch-events-test', db, embedder: null as any });
}

describe('dispatch events routes', () => {
  let services: Services;

  beforeEach(() => {
    services = tempServices();
  });

  test('POST accepts a batch and records events', async () => {
    const req = new Request('http://x/dispatch/events', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
          { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:01.000Z' },
        ],
      }),
    });

    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 2 });
    expect(services.dispatchEventLog.listByHandoff('h-1')).toHaveLength(2);
  });

  test('POST rejects malformed payloads and unknown event kinds', async () => {
    const malformed = await dispatchEventsPostRoute(
      new Request('http://x/dispatch/events', { method: 'POST', body: '{"events":"nope"}' }),
      services,
    );
    expect(malformed.status).toBe(400);

    const unknownKind = await dispatchEventsPostRoute(
      new Request('http://x/dispatch/events', {
        method: 'POST',
        body: JSON.stringify({ events: [{ handoff_id: 'h-1', source: 'worker', kind: 'bogus.kind', ts: 't' }] }),
      }),
      services,
    );
    expect(unknownKind.status).toBe(400);
    expect(services.dispatchEventLog.listByHandoff('h-1')).toHaveLength(0);
  });

  test('POST caps batches at 50 events', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({
      handoff_id: 'h-1',
      source: 'worker',
      kind: 'proc.spawn',
      ts: `2026-05-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));

    const res = await dispatchEventsPostRoute(
      new Request('http://x/dispatch/events', { method: 'POST', body: JSON.stringify({ events }) }),
      services,
    );
    expect(res.status).toBe(400);
  });

  test('GET returns requested handoff timeline ordered by timestamp', async () => {
    services.dispatchEventLog.recordBatch([
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:02.000Z' },
      { handoff_id: 'h-2', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.500Z' },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'proc.spawn', ts: '2026-05-01T00:00:01.000Z', meta: { pid: 123 } },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
    ]);

    const res = await dispatchEventsGetRoute(new Request('http://x/dispatch/events?handoff_id=h-1'), services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ handoff_id: string; kind: string; meta: unknown }> };
    expect(body.events.map((e) => e.kind)).toEqual(['dispatch.start', 'proc.spawn', 'dispatch.end']);
    expect(body.events.every((e) => e.handoff_id === 'h-1')).toBe(true);
    expect(body.events[1].meta).toEqual({ pid: 123 });
  });

  test('GET returns 400 without handoff_id and empty list for unknown handoff', async () => {
    expect((await dispatchEventsGetRoute(new Request('http://x/dispatch/events'), services)).status).toBe(400);
    const res = await dispatchEventsGetRoute(new Request('http://x/dispatch/events?handoff_id=missing'), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  test('serve.ts wires authenticated GET and POST /dispatch/events', async () => {
    const handler = createDaemonFetchHandler({ services, token: 'tok' });
    const post = await handler(new Request('http://x/dispatch/events', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({
        events: [{ handoff_id: 'h-9', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' }],
      }),
    }));
    expect(post.status).toBe(200);

    const get = await handler(new Request('http://x/dispatch/events?handoff_id=h-9', {
      headers: { authorization: 'Bearer tok' },
    }));
    expect(get.status).toBe(200);
    expect(((await get.json()) as { events: unknown[] }).events).toHaveLength(1);
  });
});
