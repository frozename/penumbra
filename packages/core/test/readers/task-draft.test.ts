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

  test('fallback removed; escalation surface awaits dedicated reader', () => {
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

    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      expect(reader.listPending({ latest_event_type: 'task_draft', project_id: 'p1' })).toEqual([]);
      expect(reader.listPending({ latest_event_type: 'task_draft_escalation', project_id: 'p1' })).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
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
