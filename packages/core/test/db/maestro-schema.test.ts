import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

test('maestro schema migrates to version 14 and stays idempotent', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });

  const version = db
    .query<{ value: string }, [string]>(
      'SELECT value FROM db_meta WHERE key = ?',
    )
    .get('schema_version');
  expect(version?.value).toBe('15');
  expect(SCHEMA_VERSION).toBe(15);

  const taskCols = db
    .query<{ name: string }, []>(`PRAGMA table_info('tasks')`)
    .all()
    .map((col) => col.name);
  expect(taskCols).toEqual([
    'id',
    'created_at',
    'updated_at',
    'created_by_kind',
    'created_by_id',
    'project_id',
    'parent_task_id',
    'kind',
    'priority',
    'prompt',
    'acceptance_criteria',
    'expected_artifacts',
    'eligibility',
    'review_eligibility',
    'requires_review',
    'bounds_wall_clock_ms',
    'bounds_cost_cents',
    'bounds_max_sub_dispatches',
    'bounds_started_at',
    'branch_base',
    'status',
    'result_summary',
    'result_artifacts',
    'failure_reason',
    'chain_id',
    'origin',
    'gh_issue_number',
    'gh_issue_repo',
    'gh_last_comment_id',
    'gh_comments_synced_at',
    'gh_create_status',
    'gh_create_error',
  ]);

  const taskEventCols = db
    .query<{ name: string }, []>(`PRAGMA table_info('task_events')`)
    .all()
    .map((col) => col.name);
  expect(taskEventCols).toEqual([
    'id',
    'task_id',
    'maestro_session_task_id',
    'at',
    'kind',
    'actor',
    'payload_json',
  ]);

  const maestroCols = db
    .query<{ name: string }, []>(`PRAGMA table_info('maestro_sessions')`)
    .all()
    .map((col) => col.name);
  expect(maestroCols).toEqual([
    'task_id',
    'chain_handoff_id',
    'agent_id',
    'started_at',
    'wall_clock_budget_ms',
    'cost_budget_cents',
    'sub_dispatch_budget',
    'cost_consumed_cents',
    'sub_dispatches_consumed',
    'soft_warned_at',
    'terminated_at',
    'termination_reason',
  ]);

  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='maestro_sessions'",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(['maestro_sessions']);

  const indexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='maestro_sessions' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toContain('maestro_sessions_chain_handoff_id');
  expect(indexes).toContain('maestro_sessions_terminated_at');

  db.close();
});
