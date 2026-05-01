import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { applySchema } from '../../../core/src/db/schema.js';
import { dispatchEventsGetRoute } from '../../src/routes/dispatch-events.js';

type DispatchEventInput = {
  handoff_id: string;
  worker_id?: string | null;
  source: 'worker' | 'daemon';
  kind: string;
  ts: string;
  meta?: Record<string, unknown>;
};

type DispatchEventRow = {
  handoff_id: string;
  worker_id: string | null;
  source: 'worker' | 'daemon';
  kind: string;
  ts: string;
  meta_json: string | null;
};

type DispatchEventLogStub = {
  recordBatch(events: DispatchEventInput[]): void;
  listByHandoff(handoff_id: string): DispatchEventRow[];
};

function tempServices(): Services & { dispatchEventLog: DispatchEventLogStub } {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/de-get',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  }) as Services & { dispatchEventLog: DispatchEventLogStub };
  const rows: DispatchEventRow[] = [];
  services.dispatchEventLog = {
    recordBatch(events) {
      for (const event of events) {
        rows.push({
          handoff_id: event.handoff_id,
          worker_id: event.worker_id ?? null,
          source: event.source,
          kind: event.kind,
          ts: event.ts,
          meta_json: event.meta ? JSON.stringify(event.meta) : null,
        });
      }
    },
    listByHandoff(handoff_id) {
      return rows
        .filter((row) => row.handoff_id === handoff_id)
        .sort((a, b) => a.ts.localeCompare(b.ts));
    },
  };
  return services;
}

describe('GET /dispatch/events', () => {
  let services: Services & { dispatchEventLog: DispatchEventLogStub };

  beforeEach(() => {
    services = tempServices();
    services.dispatchEventLog.recordBatch([
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'proc.spawn', ts: '2026-05-01T00:00:01.000Z', meta: { pid: 123 } },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:02.000Z' },
      { handoff_id: 'h-2', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.500Z' },
    ]);
  });

  test('returns events for the requested handoff in ts order', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=h-1');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string; meta: unknown }> };
    expect(body.events.map((e) => e.kind)).toEqual(['dispatch.start', 'proc.spawn', 'dispatch.end']);
    expect(body.events[1].meta).toEqual({ pid: 123 });
  });

  test('does not include events from other handoffs', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=h-1');
    const res = await dispatchEventsGetRoute(req, services);
    const body = (await res.json()) as { events: Array<{ handoff_id: string }> };
    for (const e of body.events) expect(e.handoff_id).toBe('h-1');
  });

  test('400 when handoff_id missing', async () => {
    const req = new Request('http://x/dispatch/events');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_handoff_id' });
  });

  test('200 with empty array for unknown handoff', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=does-not-exist');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });
});
