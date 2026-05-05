import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, MaestroSessionWriter, migrate } from '@penumbra/core';
import { enforceMaestroBudget } from '../../src/maestro/chain-budget-gate.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {}
}

function setupDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedTask(db: Database, taskId: string): void {
  db.query<unknown, [
    string,
    number,
    number,
    string,
    string,
    string | null,
    string,
    string,
    string,
    string | null,
    string | null,
    string,
    string | null,
    number,
    number | null,
    number | null,
    number | null,
    string | null,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ]>(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      bounds_started_at, status, result_summary, result_artifacts,
      failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    1,
    1,
    'workflow',
    'test-suite',
    null,
    'orchestrate',
    'normal',
    'coordinate the run',
    null,
    null,
    '{}',
    null,
    0,
    null,
    null,
    null,
    null,
    'pending',
    null,
    null,
    null,
    null,
    null,
  );
}

function startSession(
  sessions: MaestroSessionWriter,
  args: {
    taskId: string;
    chainHandoffId: string;
    subDispatchBudget: number;
  },
): void {
  sessions.start({
    task_id: args.taskId,
    chain_handoff_id: args.chainHandoffId,
    agent_id: 'claude-acp-sonnet',
    wall_clock_budget_ms: 60_000,
    cost_budget_cents: 100,
    sub_dispatch_budget: args.subDispatchBudget,
  });
}

let db: Database;
let sessions: MaestroSessionWriter;

beforeEach(() => {
  db = setupDb();
  sessions = new MaestroSessionWriter({ db, now: () => 0 });
});

test('no parent_handoff_id returns ok', () => {
  const a = enforceMaestroBudget({ db, sessions, parent_handoff_id: undefined });
  const b = enforceMaestroBudget({ db, sessions, parent_handoff_id: '' });
  expect(a).toEqual({ ok: true });
  expect(b).toEqual({ ok: true });
});

test('unknown parent_handoff_id returns ok', () => {
  const result = enforceMaestroBudget({ db, sessions, parent_handoff_id: 'missing' });
  expect(result).toEqual({ ok: true });
});

test('terminated session parent_handoff_id returns ok', () => {
  seedTask(db, 'task-terminated');
  startSession(sessions, {
    taskId: 'task-terminated',
    chainHandoffId: 'h-terminated',
    subDispatchBudget: 10,
  });
  sessions.terminate('task-terminated', 'cancelled');

  const result = enforceMaestroBudget({ db, sessions, parent_handoff_id: 'h-terminated' });
  expect(result).toEqual({ ok: true });
});

test('live session below limit increments and returns ok', () => {
  seedTask(db, 'task-9of10');
  startSession(sessions, {
    taskId: 'task-9of10',
    chainHandoffId: 'h-9of10',
    subDispatchBudget: 10,
  });
  for (let i = 0; i < 9; i++) {
    sessions.incrementSubDispatch('task-9of10');
  }

  const result = enforceMaestroBudget({ db, sessions, parent_handoff_id: 'h-9of10' });
  expect(result).toEqual({ ok: true });
  expect(sessions.get('task-9of10')?.sub_dispatches_consumed).toBe(10);
});

test('live session at limit returns 429 and does not increment', () => {
  seedTask(db, 'task-10of10');
  startSession(sessions, {
    taskId: 'task-10of10',
    chainHandoffId: 'h-10of10',
    subDispatchBudget: 10,
  });
  for (let i = 0; i < 10; i++) {
    sessions.incrementSubDispatch('task-10of10');
  }

  const before = sessions.get('task-10of10')?.sub_dispatches_consumed;
  const result = enforceMaestroBudget({ db, sessions, parent_handoff_id: 'h-10of10' });
  expect(result).toEqual({
    ok: false,
    status: 429,
    body: {
      error: 'BudgetExceeded',
      axis: 'sub_dispatches',
      limit: 10,
      observed: 10,
    },
  });
  expect(sessions.get('task-10of10')?.sub_dispatches_consumed).toBe(before);
});

test('concurrent gate calls allow 10 and tolerate one over-the-line race', async () => {
  seedTask(db, 'task-concurrent');
  startSession(sessions, {
    taskId: 'task-concurrent',
    chainHandoffId: 'h-concurrent',
    subDispatchBudget: 10,
  });

  const results = await Promise.all(
    Array.from({ length: 50 }, () => Promise.resolve().then(() => enforceMaestroBudget({
      db,
      sessions,
      parent_handoff_id: 'h-concurrent',
    }))),
  );

  const okCount = results.filter((r) => r.ok).length;
  const blocked = results.filter((r) => !r.ok);
  expect(okCount).toBeGreaterThanOrEqual(10);
  expect(okCount).toBeLessThanOrEqual(11);
  expect(blocked.length).toBe(50 - okCount);
  expect(blocked.every((r) => !r.ok && r.status === 429)).toBeTrue();

  const consumed = sessions.get('task-concurrent')?.sub_dispatches_consumed ?? 0;
  expect(consumed).toBeGreaterThanOrEqual(10);
  expect(consumed).toBeLessThanOrEqual(11);
});
