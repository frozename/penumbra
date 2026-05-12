import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { closeLane, getLane, insertLane, recentLanes } from '../../src/db/lane-ledger.js';

const CREATE_LANE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS lane_ledger (
    lane_id              TEXT PRIMARY KEY,
    ts_opened            TEXT NOT NULL,
    ts_closed            TEXT,
    task_class           TEXT NOT NULL,
    implementer_handoff  TEXT NOT NULL,
    reviewer_handoff     TEXT,
    gate_status          TEXT NOT NULL,
    recalled_memory_ids  TEXT NOT NULL DEFAULT '[]',
    recalled_query       TEXT,
    override_reason      TEXT,
    metadata_json        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS lane_ledger_by_status_ts ON lane_ledger(gate_status, ts_opened DESC);
  CREATE INDEX IF NOT EXISTS lane_ledger_by_task_class ON lane_ledger(task_class, ts_opened DESC);
`;

describe('lane-ledger dao', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(CREATE_LANE_LEDGER_SQL);
  });

  it('round-trips an inserted lane', () => {
    insertLane(db, {
      lane_id: 'lane-1',
      ts_opened: '2026-05-12T10:00:00.000Z',
      task_class: 'BOUNDARY',
      implementer_handoff: 'handoff-1',
      gate_status: 'open',
      recalled_memory_ids: ['m1', 'm2'],
      recalled_query: 'quality push',
      metadata_json: '{"source":"test"}',
    });

    expect(getLane(db, 'lane-1')).toEqual({
      lane_id: 'lane-1',
      ts_opened: '2026-05-12T10:00:00.000Z',
      ts_closed: null,
      task_class: 'BOUNDARY',
      implementer_handoff: 'handoff-1',
      reviewer_handoff: null,
      gate_status: 'open',
      recalled_memory_ids: ['m1', 'm2'],
      recalled_query: 'quality push',
      override_reason: null,
      metadata_json: '{"source":"test"}',
    });
  });

  it('applies defaults when optional fields are omitted', () => {
    insertLane(db, {
      lane_id: 'lane-2',
      ts_opened: '2026-05-12T10:05:00.000Z',
      task_class: 'STANDARD',
      implementer_handoff: 'handoff-2',
      gate_status: 'open',
    });

    expect(getLane(db, 'lane-2')).toEqual({
      lane_id: 'lane-2',
      ts_opened: '2026-05-12T10:05:00.000Z',
      ts_closed: null,
      task_class: 'STANDARD',
      implementer_handoff: 'handoff-2',
      reviewer_handoff: null,
      gate_status: 'open',
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: '{}',
    });
  });

  it('closes a lane and persists the final gate status', () => {
    insertLane(db, {
      lane_id: 'lane-3',
      ts_opened: '2026-05-12T10:10:00.000Z',
      task_class: 'TRIVIAL',
      implementer_handoff: 'handoff-3',
      gate_status: 'open',
    });

    closeLane(db, 'lane-3', {
      ts_closed: '2026-05-12T10:15:00.000Z',
      gate_status: 'passed',
      reviewer_handoff: 'reviewer-1',
      override_reason: 'approved by reviewer',
    });

    expect(getLane(db, 'lane-3')).toEqual({
      lane_id: 'lane-3',
      ts_opened: '2026-05-12T10:10:00.000Z',
      ts_closed: '2026-05-12T10:15:00.000Z',
      task_class: 'TRIVIAL',
      implementer_handoff: 'handoff-3',
      reviewer_handoff: 'reviewer-1',
      gate_status: 'passed',
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: 'approved by reviewer',
      metadata_json: '{}',
    });
  });

  it('throws on double-close', () => {
    insertLane(db, {
      lane_id: 'lane-4',
      ts_opened: '2026-05-12T10:20:00.000Z',
      task_class: 'BOUNDARY',
      implementer_handoff: 'handoff-4',
      gate_status: 'open',
    });
    closeLane(db, 'lane-4', { ts_closed: '2026-05-12T10:25:00.000Z', gate_status: 'failed' });

    expect(() =>
      closeLane(db, 'lane-4', { ts_closed: '2026-05-12T10:30:00.000Z', gate_status: 'passed' }),
    ).toThrow();
  });

  it('rejects invalid close statuses', () => {
    insertLane(db, {
      lane_id: 'lane-5',
      ts_opened: '2026-05-12T10:30:00.000Z',
      task_class: 'STANDARD',
      implementer_handoff: 'handoff-5',
      gate_status: 'open',
    });

    expect(() =>
      closeLane(db, 'lane-5', { ts_closed: '2026-05-12T10:35:00.000Z', gate_status: 'open' as any }),
    ).toThrow();
  });

  it('filters and orders recent lanes by status, task class, and since', () => {
    insertLane(db, {
      lane_id: 'lane-a',
      ts_opened: '2026-05-12T10:00:00.000Z',
      task_class: 'BOUNDARY',
      implementer_handoff: 'handoff-a',
      gate_status: 'open',
    });
    insertLane(db, {
      lane_id: 'lane-b',
      ts_opened: '2026-05-12T10:05:00.000Z',
      task_class: 'STANDARD',
      implementer_handoff: 'handoff-b',
      gate_status: 'passed',
    });
    insertLane(db, {
      lane_id: 'lane-c',
      ts_opened: '2026-05-12T10:10:00.000Z',
      task_class: 'STANDARD',
      implementer_handoff: 'handoff-c',
      gate_status: 'passed',
    });

    expect(recentLanes(db, { gate_status: 'passed' }, 50).map((row) => row.lane_id)).toEqual(['lane-c', 'lane-b']);
    expect(recentLanes(db, { task_class: 'STANDARD' }, 50).map((row) => row.lane_id)).toEqual(['lane-c', 'lane-b']);
    expect(recentLanes(db, { since_iso: '2026-05-12T10:06:00.000Z' }, 50).map((row) => row.lane_id)).toEqual(['lane-c']);
  });

  it('returns null for unknown lanes', () => {
    expect(getLane(db, 'missing')).toBeNull();
  });

  it('preserves recalled_memory_ids as json', () => {
    insertLane(db, {
      lane_id: 'lane-json',
      ts_opened: '2026-05-12T10:40:00.000Z',
      task_class: 'TRIVIAL',
      implementer_handoff: 'handoff-json',
      gate_status: 'open',
      recalled_memory_ids: ['mem-1', 'mem-2', 'mem-3'],
    });

    const raw = db.query<{ recalled_memory_ids: string }, [string]>(
      'SELECT recalled_memory_ids FROM lane_ledger WHERE lane_id=?',
    ).get('lane-json');
    expect(raw?.recalled_memory_ids).toBe('["mem-1","mem-2","mem-3"]');
    expect(getLane(db, 'lane-json')?.recalled_memory_ids).toEqual(['mem-1', 'mem-2', 'mem-3']);
  });
});
