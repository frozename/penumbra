import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema, SCHEMA_VERSION } from '../../src/db/schema.js';
import { migrate } from '../../src/db/migrations.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

test('schema_version is bumped to 12 on migrate', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const meta = db
    .query<{ value: string }, [string]>(
      `SELECT value FROM db_meta WHERE key = ?`,
    )
    .get('schema_version');
  expect(meta?.value).toBe('12');
  expect(SCHEMA_VERSION).toBe(12);

  db.close();
});

test('applySchema creates task board tables and indexes', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);

  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'task_leases', 'task_events') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(['task_events', 'task_leases', 'tasks']);

  const tasksCols = db
    .query<{ name: string; type: string }, []>(`PRAGMA table_info('tasks')`)
    .all();
  expect(tasksCols.map((col) => col.name)).toEqual([
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
  ]);
  expect(tasksCols.map((col) => col.type)).toEqual([
    'TEXT',
    'INTEGER',
    'INTEGER',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'INTEGER',
    'INTEGER',
    'INTEGER',
    'INTEGER',
    'INTEGER',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'TEXT',
    'INTEGER',
    'TEXT',
  ]);

  const taskLeasesCols = db
    .query<{ name: string; type: string }, []>(`PRAGMA table_info('task_leases')`)
    .all();
  expect(taskLeasesCols.map((col) => col.name)).toEqual([
    'id',
    'task_id',
    'agent_id',
    'claimed_at',
    'expires_at',
    'released_at',
    'release_reason',
    'auction_score',
  ]);
  expect(taskLeasesCols.map((col) => col.type)).toEqual([
    'TEXT',
    'TEXT',
    'TEXT',
    'INTEGER',
    'INTEGER',
    'INTEGER',
    'TEXT',
    'REAL',
  ]);

  const taskEventsCols = db
    .query<{ name: string; type: string }, []>(`PRAGMA table_info('task_events')`)
    .all();
  expect(taskEventsCols.map((col) => col.name)).toEqual([
    'id',
    'task_id',
    'maestro_session_task_id',
    'at',
    'kind',
    'actor',
    'payload_json',
  ]);
  expect(taskEventsCols.map((col) => col.type)).toEqual([
    'INTEGER',
    'TEXT',
    'TEXT',
    'INTEGER',
    'TEXT',
    'TEXT',
    'TEXT',
  ]);

  const indexes = db
    .query<{ name: string; tbl_name: string }, []>(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks', 'task_leases', 'task_events') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toContain('tasks_status_priority_created_at');
  expect(indexes).toContain('tasks_parent_task_id');
  expect(indexes).toContain('tasks_created_by_id');
  expect(indexes).toContain('tasks_chain_id');
  expect(indexes).toContain('tasks_by_gh');
  expect(indexes).toContain('task_leases_task_id_released_at');
  expect(indexes).toContain('task_leases_agent_id_released_at');
  expect(indexes).toContain('task_events_task_id_at');

  db.close();
});
