import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TaskDraftReader } from '../../src/readers/task-draft.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
  return db;
}

function insertDraft(db: Database, input: {
  event_id: string;
  ts: string;
  ingest_ts: string;
  project_id: string | null;
  event_type: 'task_draft' | 'task_draft_refining' | 'task_draft_promoted' | 'task_draft_stale' | 'task_draft_duplicate' | 'task_draft_escalation';
  draft_id: string;
  payload: unknown;
}) {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane, payload_json)
     VALUES (?, ?, ?, 'mcp', ?, 'u', 'm', ?, 'unknown', ?)`,
    [input.event_id, input.ts, input.ingest_ts, input.project_id, input.event_type, JSON.stringify(input.payload)],
  );
}

describe('TaskDraftReader.listPending', () => {
  let db: Database;
  let reader: TaskDraftReader;

  beforeEach(() => {
    db = freshDb();
    reader = new TaskDraftReader({ db });
  });

  test('returns drafts with only task_draft latest event', () => {
    insertDraft(db, {
      event_id: 'e1',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '11111111-1111-4111-8111-111111111111',
      payload: {
        draft_id: '11111111-1111-4111-8111-111111111111',
        prompt: 'p',
        affects_projects: ['a'],
        evidence: {},
        auto_ok: true,
        filed_by_agent: 'agent',
        filed_via: 'skill_inline',
        parent_draft_id: null,
      },
    });

    expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' }).map((r) => r.event_id)).toEqual(['e1']);
    expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'any-project' }).map((r) => r.event_id)).toEqual([]);
  });

  test('skips drafts whose latest event is refining', () => {
    const draftId = '22222222-2222-4222-8222-222222222222';
    insertDraft(db, {
      event_id: 'e1',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'e2',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_refining',
      draft_id: draftId,
      payload: { draft_id: draftId },
    });

    expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' })).toEqual([]);
  });

  test('escalation queries short-circuit to empty with warn', () => {
    const draftId = '33333333-3333-4333-8333-333333333333';
    insertDraft(db, {
      event_id: 'e1',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'e2',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: draftId,
      payload: { draft_id: draftId, escalation_reason: 'x' },
    });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' })).toEqual([]);
      expect(reader.listPending({ latest_event_type: 'task_draft_escalation', project_id: 'p1' })).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/escalation surface awaits dedicated reader/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('FIFO tie-break: equal ts ordered by ingest_ts ASC', () => {
    const draftIdA = '55555555-5555-4555-8555-555555555555';
    const draftIdB = '66666666-6666-4666-8666-666666666666';
    insertDraft(db, {
      event_id: 'eB-late-ingest',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:02.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftIdB,
      payload: { draft_id: draftIdB, prompt: 'B', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'eA-early-ingest',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftIdA,
      payload: { draft_id: draftIdA, prompt: 'A', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });

    expect(
      reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' }).map((r) => r.event_id),
    ).toEqual(['eA-early-ingest', 'eB-late-ingest']);
  });

  test('skips promoted drafts', () => {
    const draftId = '44444444-4444-4444-8444-444444444444';
    insertDraft(db, {
      event_id: 'e1',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'e2',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_promoted',
      draft_id: draftId,
      payload: { draft_id: draftId, task_ids: ['t1'] },
    });

    expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' })).toEqual([]);
  });

  test('applies project_id filter and limit and orders FIFO', () => {
    insertDraft(db, {
      event_id: 'a',
      ts: '2026-05-16T00:00:02.000Z',
      ingest_ts: '2026-05-16T00:00:03.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '55555555-5555-4555-8555-555555555555',
      payload: { draft_id: '55555555-5555-4555-8555-555555555555', prompt: 'a', affects_projects: ['x'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'b',
      ts: '2026-05-16T00:00:01.000Z',
      ingest_ts: '2026-05-16T00:00:02.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '66666666-6666-4666-8666-666666666666',
      payload: { draft_id: '66666666-6666-4666-8666-666666666666', prompt: 'b', affects_projects: ['x'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'c',
      ts: '2026-05-16T00:00:03.000Z',
      ingest_ts: '2026-05-16T00:00:04.000Z',
      project_id: 'p2',
      event_type: 'task_draft',
      draft_id: '77777777-7777-4777-8777-777777777777',
      payload: { draft_id: '77777777-7777-4777-8777-777777777777', prompt: 'c', affects_projects: ['x'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });

    const out = reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1', limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.event_id).toBe('b');
  });

  test('skips corrupted payloads and keeps siblings', () => {
    insertDraft(db, {
      event_id: 'bad',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '88888888-8888-4888-8888-888888888888',
      payload: { draft_id: 'not-a-uuid', prompt: 'bad' },
    });
    insertDraft(db, {
      event_id: 'good',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '99999999-9999-4999-8999-999999999999',
      payload: { draft_id: '99999999-9999-4999-8999-999999999999', prompt: 'ok', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });

    const out = reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' });
    expect(out.map((r) => r.event_id)).toEqual(['good']);
  });
});

describe('TaskDraftReader.listPendingEscalations', () => {
  let db: Database;
  let reader: TaskDraftReader;

  beforeEach(() => {
    db = freshDb();
    reader = new TaskDraftReader({ db });
  });

  test('returns escalations joined to original draft payload', () => {
    const draftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    insertDraft(db, {
      event_id: 'draft',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'original prompt', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'escalation',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: draftId,
      payload: { draft_id: draftId, escalation_reason: 'needs review' },
    });

    const out = reader.listPendingEscalations({ project_id: 'p1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      event_id: 'escalation',
      ts: '2026-05-16T00:01:00.000Z',
      project_id: 'p1',
      prompt: 'original prompt',
      escalation_reason: 'needs review',
      escalation_event_id: 'escalation',
      escalation_ts: '2026-05-16T00:01:00.000Z',
    });
  });

  test('does not disclose original draft payload across project boundaries', () => {
    const draftId = 'abababab-abab-4aba-8aba-abababababab';
    insertDraft(db, {
      event_id: 'draft-a',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'project-a',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'secret-A', affects_projects: ['x'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'escalation-b',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'project-b',
      event_type: 'task_draft_escalation',
      draft_id: draftId,
      payload: { draft_id: draftId, escalation_reason: 'needs review' },
    });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      expect(reader.listPendingEscalations({ project_id: 'project-b' })).toEqual([]);
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('does not return drafts whose latest event is refining or promoted', () => {
    const refiningId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    insertDraft(db, {
      event_id: 'draft-refining',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: refiningId,
      payload: { draft_id: refiningId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'escalation-refining',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: refiningId,
      payload: { draft_id: refiningId, escalation_reason: 'x' },
    });
    insertDraft(db, {
      event_id: 'refining',
      ts: '2026-05-16T00:02:00.000Z',
      ingest_ts: '2026-05-16T00:02:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_refining',
      draft_id: refiningId,
      payload: { draft_id: refiningId },
    });

    const promotedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    insertDraft(db, {
      event_id: 'draft-promoted',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: promotedId,
      payload: { draft_id: promotedId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'escalation-promoted',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: promotedId,
      payload: { draft_id: promotedId, escalation_reason: 'x' },
    });
    insertDraft(db, {
      event_id: 'promoted',
      ts: '2026-05-16T00:02:00.000Z',
      ingest_ts: '2026-05-16T00:02:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_promoted',
      draft_id: promotedId,
      payload: { draft_id: promotedId, task_ids: ['t1'] },
    });

    expect(reader.listPendingEscalations({ project_id: 'p1' })).toEqual([]);
  });

  test('skips drafts that were never escalated', () => {
    const draftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    insertDraft(db, {
      event_id: 'draft',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });

    expect(reader.listPendingEscalations({ project_id: 'p1' })).toEqual([]);
  });

  test('skips malformed escalation payloads with warning', () => {
    const draftId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    insertDraft(db, {
      event_id: 'draft',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: draftId,
      payload: { draft_id: draftId, prompt: 'p', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'escalation',
      ts: '2026-05-16T00:01:00.000Z',
      ingest_ts: '2026-05-16T00:01:01.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: draftId,
      payload: { draft_id: draftId, escalation_reason: '' },
    });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      expect(reader.listPendingEscalations({ project_id: 'p1' })).toEqual([]);
      expect(warnings.join('\n')).toMatch(/escalation/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('applies project_id filter, limit, and FIFO order', () => {
    insertDraft(db, {
      event_id: 'b-escalation',
      ts: '2026-05-16T00:00:02.000Z',
      ingest_ts: '2026-05-16T00:00:03.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      payload: { draft_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', prompt: 'b', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'b',
      ts: '2026-05-16T00:00:03.000Z',
      ingest_ts: '2026-05-16T00:00:04.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      payload: { draft_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', escalation_reason: 'b' },
    });
    insertDraft(db, {
      event_id: 'a-escalation',
      ts: '2026-05-16T00:00:01.000Z',
      ingest_ts: '2026-05-16T00:00:02.000Z',
      project_id: 'p1',
      event_type: 'task_draft',
      draft_id: '99999999-9999-4999-8999-999999999998',
      payload: { draft_id: '99999999-9999-4999-8999-999999999998', prompt: 'a', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'a',
      ts: '2026-05-16T00:00:01.000Z',
      ingest_ts: '2026-05-16T00:00:03.000Z',
      project_id: 'p1',
      event_type: 'task_draft_escalation',
      draft_id: '99999999-9999-4999-8999-999999999998',
      payload: { draft_id: '99999999-9999-4999-8999-999999999998', escalation_reason: 'a' },
    });
    insertDraft(db, {
      event_id: 'other-project-escalation',
      ts: '2026-05-16T00:00:00.000Z',
      ingest_ts: '2026-05-16T00:00:01.000Z',
      project_id: 'p2',
      event_type: 'task_draft',
      draft_id: '88888888-8888-4888-8888-888888888888',
      payload: { draft_id: '88888888-8888-4888-8888-888888888888', prompt: 'c', affects_projects: ['a'], evidence: {}, auto_ok: true, filed_by_agent: 'agent', filed_via: 'skill_inline', parent_draft_id: null },
    });
    insertDraft(db, {
      event_id: 'other-project',
      ts: '2026-05-16T00:00:01.000Z',
      ingest_ts: '2026-05-16T00:00:02.000Z',
      project_id: 'p2',
      event_type: 'task_draft_escalation',
      draft_id: '88888888-8888-4888-8888-888888888888',
      payload: { draft_id: '88888888-8888-4888-8888-888888888888', escalation_reason: 'c' },
    });

    const out = reader.listPendingEscalations({ project_id: 'p1', limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.event_id).toBe('a');
  });

  test('EXPLAIN QUERY PLAN mentions t0_events_task_draft_id_lookup for escalation join', () => {
    const sql = `WITH ranked AS (
        SELECT
          event_id, ts, ingest_ts, project_id, event_type, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id')
            ORDER BY ts DESC, ingest_ts DESC
          ) AS rn
        FROM t0_events
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        )
      ),
      originals AS (
        SELECT
          event_id, ts, project_id, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id'), project_id
            ORDER BY ts ASC, ingest_ts ASC, event_id ASC
          ) AS rn
        FROM t0_events
        WHERE event_type = 'task_draft'
      )
      SELECT
        ranked.event_id AS escalation_event_id,
        ranked.ts AS escalation_ts,
        ranked.payload_json AS escalation_payload,
        ranked.project_id AS escalation_project_id,
        originals.event_id AS original_event_id,
        originals.ts AS original_ts,
        originals.project_id AS original_project_id,
        originals.payload_json AS original_payload
      FROM ranked
      JOIN originals
        ON originals.draft_id = ranked.draft_id
        AND originals.project_id = ranked.project_id
        AND originals.rn = 1
      WHERE ranked.rn = 1
        AND ranked.event_type = 'task_draft_escalation'
        AND ranked.project_id = ?
      ORDER BY ranked.ts ASC, ranked.ingest_ts ASC, ranked.event_id ASC
      LIMIT ?`;
    const planRows = db.query('EXPLAIN QUERY PLAN ' + sql).all('p1', 1) as Array<{ detail: string }>;
    const allDetail = planRows.map((row) => row.detail).join(' ');
    expect(allDetail).toContain('t0_events_task_draft_id_lookup');
  });
});
