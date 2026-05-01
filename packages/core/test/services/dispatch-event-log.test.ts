import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { DispatchEventLog, type DispatchEventInput } from '../../src/services/dispatch-event-log.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

const sampleEvent: DispatchEventInput = {
  handoff_id: 'h-1',
  worker_id: 'w-1',
  source: 'worker',
  kind: 'dispatch.start',
  ts: '2026-05-01T00:00:00.000Z',
  meta: { agent: 'gemini', adapter: 'gemini-cli' },
};

describe('DispatchEventLog', () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test('record inserts a single event with serialized meta', () => {
    const log = new DispatchEventLog(db);
    log.record(sampleEvent);

    const rows = db.query('SELECT * FROM dispatch_events').all() as Array<{
      handoff_id: string;
      worker_id: string;
      kind: string;
      meta_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].handoff_id).toBe('h-1');
    expect(rows[0].worker_id).toBe('w-1');
    expect(rows[0].kind).toBe('dispatch.start');
    expect(JSON.parse(rows[0].meta_json)).toEqual(sampleEvent.meta);
  });

  test('recordBatch inserts many events in one call', () => {
    const log = new DispatchEventLog(db);
    log.recordBatch(Array.from({ length: 5 }, (_, i) => ({
      ...sampleEvent,
      ts: `2026-05-01T00:00:0${i}.000Z`,
      kind: 'proc.spawn',
    })));

    const count = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM dispatch_events').get();
    expect(count?.c).toBe(5);
  });

  test('listByHandoff returns events ordered by timestamp then id', () => {
    const log = new DispatchEventLog(db);
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:02.000Z', kind: 'dispatch.end' });
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:00.000Z', kind: 'dispatch.start' });
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:01.000Z', kind: 'proc.spawn' });

    expect(log.listByHandoff('h-1').map((e) => e.kind)).toEqual([
      'dispatch.start',
      'proc.spawn',
      'dispatch.end',
    ]);
  });

  test('record omits meta when undefined', () => {
    const log = new DispatchEventLog(db);
    log.record({ ...sampleEvent, meta: undefined });

    const row = db.query<{ meta_json: string | null }, []>('SELECT meta_json FROM dispatch_events').get();
    expect(row?.meta_json).toBeNull();
  });
});
