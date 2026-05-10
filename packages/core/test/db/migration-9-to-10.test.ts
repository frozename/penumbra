import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

function schemaVersion(db: Database): string | undefined {
  return db
    .query<{ value: string }, [string]>(
      'SELECT value FROM db_meta WHERE key = ?',
    )
    .get('schema_version')?.value;
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'task_leases', 'task_events', 'maestro_sessions') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function indexNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks', 'task_leases', 'task_events', 'maestro_sessions') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

function seedTask(db: Database, id: string): void {
  db.exec(`
    INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id, parent_task_id,
      kind, priority, prompt, acceptance_criteria, expected_artifacts,
      eligibility, review_eligibility, requires_review, bounds_wall_clock_ms,
      bounds_cost_cents, bounds_max_sub_dispatches, bounds_started_at, status,
      result_summary, result_artifacts, failure_reason, chain_id, origin
    ) VALUES (
      '${id}', 1000, 2000, 'agent', 'agent-1', NULL, 'task', 'normal',
      'prompt ${id}', 'criteria ${id}', 'artifacts ${id}', 'eligible',
      'review', 1, 3000, 400, 5, 900, 'pending', 'summary ${id}',
      'artifacts ${id}', NULL, 'chain-1', 'origin-1'
    );
  `);
}

test('migration applies cleanly to a v14 db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });

  expect(schemaVersion(db)).toBe('15');
  expect(tableNames(db)).toEqual([
    'maestro_sessions',
    'task_events',
    'task_leases',
    'tasks',
  ]);
  expect(columnNames(db, 'tasks')).toEqual([
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
  expect(columnNames(db, 'task_events')).toEqual([
    'id',
    'task_id',
    'maestro_session_task_id',
    'at',
    'kind',
    'actor',
    'payload_json',
  ]);
  expect(columnNames(db, 'maestro_sessions')).toEqual([
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

  db.close();
});

test('migration is idempotent on a v14 db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  const firstIndexes = indexNames(db);
  migrate(db, { embeddingDim: 384 });

  expect(schemaVersion(db)).toBe('15');
  expect(tableNames(db)).toEqual([
    'maestro_sessions',
    'task_events',
    'task_leases',
    'tasks',
  ]);
  expect(indexNames(db)).toEqual(firstIndexes);
  expect(firstIndexes).toContain('task_events_task_id_at');
  expect(firstIndexes).toContain('task_leases_agent_id_released_at');
  expect(firstIndexes).toContain('task_leases_task_id_released_at');
  expect(firstIndexes).toContain('tasks_chain_id');
  expect(firstIndexes).toContain('tasks_created_by_id');
  expect(firstIndexes).toContain('tasks_parent_task_id');
  expect(firstIndexes).toContain('tasks_status_priority_created_at');
  expect(firstIndexes).toContain('maestro_sessions_chain_handoff_id');
  expect(firstIndexes).toContain('maestro_sessions_terminated_at');

  db.close();
});

test('migration preserves existing rows on a repeated run', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  seedTask(db, 'task-1');

  migrate(db, { embeddingDim: 384 });

  const task = db
    .query<{
      id: string;
      created_at: number;
      updated_at: number;
      prompt: string;
      status: string;
      chain_id: string;
    }, [string]>(
      'SELECT id, created_at, updated_at, prompt, status, chain_id FROM tasks WHERE id = ?',
    )
    .get('task-1');

  expect(task).toEqual({
    id: 'task-1',
    created_at: 1000,
    updated_at: 2000,
    prompt: 'prompt task-1',
    status: 'pending',
    chain_id: 'chain-1',
  });

  db.close();
});

test('migration recreates maestro_sessions after downgrading schema_version to 9', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);

  migrate(db, { embeddingDim: 384 });
  db.exec(`
    DROP TABLE maestro_sessions;
    UPDATE db_meta SET value = '9' WHERE key = 'schema_version';
  `);

  migrate(db, { embeddingDim: 384 });

  expect(schemaVersion(db)).toBe('15');
  expect(tableNames(db)).toEqual([
    'maestro_sessions',
    'task_events',
    'task_leases',
    'tasks',
  ]);
  expect(indexNames(db)).toContain('maestro_sessions_chain_handoff_id');
  expect(indexNames(db)).toContain('maestro_sessions_terminated_at');

  db.close();
});
