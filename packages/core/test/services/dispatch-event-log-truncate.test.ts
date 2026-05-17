import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';
import { applyRuntimePragmas, loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { DispatchEventLog, type DispatchEventInput } from '../../src/services/dispatch-event-log.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applyRuntimePragmas(db);
  applySchema(db);
  return db;
}

const baseEvent: DispatchEventInput = {
  handoff_id: 'h-oversized',
  worker_id: 'w-oversized',
  source: 'worker',
  kind: 'shell.run',
  ts: '2026-05-01T00:00:00.000Z',
  meta: { note: 'ok' },
};

describe('DispatchEventLog meta truncation', () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test('stores short meta verbatim', () => {
    const log = new DispatchEventLog(db);
    log.record(baseEvent);

    const row = db.query<{ meta_json: string }, []>('SELECT meta_json FROM dispatch_events').get();
    expect(JSON.parse(row!.meta_json)).toEqual(baseEvent.meta);
  });

  test('truncates oversized meta before insert and publish', () => {
    const log = new DispatchEventLog(db);
    const oversizedEvent: DispatchEventInput = {
      ...baseEvent,
      meta: {
        payload: 'x'.repeat(5000),
      },
    };

    log.record(oversizedEvent);

    const row = db.query<{ meta_json: string }, []>('SELECT meta_json FROM dispatch_events').get();
    const meta = JSON.parse(row!.meta_json) as Record<string, unknown>;

    expect(row!.meta_json.length).toBeLessThan(4096);
    expect(meta._truncated).toBe(true);
    expect(meta.kind).toBe('shell.run');
    expect(meta.original_size).toBeGreaterThan(4096);
  });

  test('rejects oversized strict meta kinds', () => {
    const log = new DispatchEventLog(db);
    expect(() => log.record({
      ...baseEvent,
      kind: 'dispatch.end',
      meta: {
        payload: 'x'.repeat(5000),
      },
    })).toThrow(/strict kind dispatch\.end/);
  });

  test('recordBatch keeps normal events when one event is oversized', () => {
    const log = new DispatchEventLog(db);
    log.recordBatch([
      {
        ...baseEvent,
        ts: '2026-05-01T00:00:00.000Z',
      },
      {
        ...baseEvent,
        ts: '2026-05-01T00:00:01.000Z',
        meta: {
          payload: 'x'.repeat(5000),
        },
      },
      {
        ...baseEvent,
        ts: '2026-05-01T00:00:02.000Z',
        kind: 'dispatch.end',
      },
    ]);

    const rows = db.query<{ meta_json: string | null }, []>('SELECT meta_json FROM dispatch_events ORDER BY ts ASC').all();
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0]!.meta_json!)).toEqual(baseEvent.meta);
    expect(JSON.parse(rows[1]!.meta_json!)).toMatchObject({
      _truncated: true,
      kind: 'shell.run',
    });
    expect(JSON.parse(rows[2]!.meta_json!)).toEqual(baseEvent.meta);
  });
});
