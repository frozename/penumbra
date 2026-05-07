import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  type BoundsAxis,
  type MaestroSessionRecord,
} from '@penumbra/core';
import { createBoundsTracker } from '../../src/maestro/bounds-tracker.js';
import { rollupCostForChain } from '../../src/maestro/cost-rollup.js';

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

function insertHandoff(db: Database, handoffId: string, parentHandoffId: string | null): void {
  db.query<unknown, [string, string, string, string, string, string, string, string, string | null]>(
    `INSERT INTO handoffs (
      handoff_id, ts, conversation_id, from_agent, to_agent, message, status, project_id, parent_handoff_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoffId,
    '2026-05-05T00:00:00.000Z',
    'conv-1',
    'maestro',
    'worker',
    'do work',
    'dispatched',
    null,
    parentHandoffId,
  );
}

function insertUsageUpdate(db: Database, input: { eventId: string; handoffId: string; costUsd: number }): void {
  db.query<unknown, [string, string, string, string, string, number, string]>(
    `INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model,
      cost_usd, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'usage-update', 'cli-subscription', ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    '2026-05-05T00:00:00.000Z',
    '2026-05-05T00:00:00.000Z',
    'agentchat',
    'u',
    'm',
    'anthropic',
    'claude-sonnet',
    input.costUsd,
    JSON.stringify({ handoff_id: input.handoffId, used: 100 }),
  );
}

function startSession(
  sessions: MaestroSessionWriter,
  args: {
    taskId: string;
    chainHandoffId: string;
    wallClockBudgetMs?: number;
    costBudgetCents?: number;
    subDispatchBudget?: number;
  },
): void {
  sessions.start({
    task_id: args.taskId,
    chain_handoff_id: args.chainHandoffId,
    agent_id: 'claude-acp-sonnet',
    wall_clock_budget_ms: args.wallClockBudgetMs ?? 10_000,
    cost_budget_cents: args.costBudgetCents ?? 100,
    sub_dispatch_budget: args.subDispatchBudget ?? 10,
  });
}

let db: Database;
let sessions: MaestroSessionWriter;
let nowMs = 0;

beforeEach(() => {
  db = setupDb();
  nowMs = 0;
  sessions = new MaestroSessionWriter({ db, now: () => nowMs });
});

test('wall-clock 79% does not warn or hard-kill', () => {
  seedTask(db, 'task-1');
  startSession(sessions, { taskId: 'task-1', chainHandoffId: 'h-root-1', wallClockBudgetMs: 10_000 });

  const softWarns: MaestroSessionRecord[] = [];
  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: (session) => softWarns.push(session),
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 7_900;
  tracker.tick();

  expect(softWarns).toHaveLength(0);
  expect(hardKills).toHaveLength(0);
  expect(sessions.get('task-1')?.soft_warned_at).toBeNull();
});

test('wall-clock 80% warns and stamps soft_warned_at', () => {
  seedTask(db, 'task-2');
  startSession(sessions, { taskId: 'task-2', chainHandoffId: 'h-root-2', wallClockBudgetMs: 10_000 });

  const softWarns: MaestroSessionRecord[] = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: (session) => softWarns.push(session),
    onHardKill: () => {},
  });

  nowMs = 8_000;
  tracker.tick();

  expect(softWarns).toHaveLength(1);
  expect(softWarns[0]?.task_id).toBe('task-2');
  expect(sessions.get('task-2')?.soft_warned_at).toBe(8_000);
});

test('soft warning is one-shot even when another axis crosses 80% later', () => {
  seedTask(db, 'task-3');
  insertHandoff(db, 'h-root-3', null);
  startSession(sessions, {
    taskId: 'task-3',
    chainHandoffId: 'h-root-3',
    wallClockBudgetMs: 10_000,
    costBudgetCents: 100,
  });

  const softWarns: MaestroSessionRecord[] = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: (session) => softWarns.push(session),
    onHardKill: () => {},
  });

  nowMs = 8_000;
  tracker.tick();
  expect(softWarns).toHaveLength(1);

  nowMs = 8_500;
  insertUsageUpdate(db, { eventId: 'u-3', handoffId: 'h-root-3', costUsd: 0.81 });
  tracker.tick();

  expect(softWarns).toHaveLength(1);
});

test('wall-clock 100% triggers hard-kill with wall_clock axis', () => {
  seedTask(db, 'task-4');
  startSession(sessions, { taskId: 'task-4', chainHandoffId: 'h-root-4', wallClockBudgetMs: 10_000 });

  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: () => {},
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 10_001;
  tracker.tick();

  expect(hardKills).toHaveLength(1);
  expect(hardKills[0]?.axis).toBe('wall_clock');
  expect(hardKills[0]?.session.task_id).toBe('task-4');
});

test('wall-clock and cost both at 100% picks wall_clock deterministically', () => {
  seedTask(db, 'task-5');
  insertHandoff(db, 'h-root-5', null);
  startSession(sessions, {
    taskId: 'task-5',
    chainHandoffId: 'h-root-5',
    wallClockBudgetMs: 10_000,
    costBudgetCents: 100,
  });
  insertUsageUpdate(db, { eventId: 'u-5', handoffId: 'h-root-5', costUsd: 1.0 });

  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: () => {},
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 10_001;
  tracker.tick();

  expect(hardKills).toHaveLength(1);
  expect(hardKills[0]?.axis).toBe('wall_clock');
});

test('cost 100% only triggers hard-kill with cost axis', () => {
  seedTask(db, 'task-6');
  insertHandoff(db, 'h-root-6', null);
  startSession(sessions, {
    taskId: 'task-6',
    chainHandoffId: 'h-root-6',
    wallClockBudgetMs: 20_000,
    costBudgetCents: 100,
  });
  insertUsageUpdate(db, { eventId: 'u-6', handoffId: 'h-root-6', costUsd: 1.0 });

  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: () => {},
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 100;
  tracker.tick();

  expect(hardKills).toHaveLength(1);
  expect(hardKills[0]?.axis).toBe('cost');
});

test('sub-dispatches 100% triggers hard-kill with sub_dispatches axis', () => {
  seedTask(db, 'task-7');
  startSession(sessions, {
    taskId: 'task-7',
    chainHandoffId: 'h-root-7',
    wallClockBudgetMs: 20_000,
    costBudgetCents: 1_000,
    subDispatchBudget: 3,
  });
  sessions.incrementSubDispatch('task-7');
  sessions.incrementSubDispatch('task-7');
  sessions.incrementSubDispatch('task-7');

  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: () => {},
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 100;
  tracker.tick();

  expect(hardKills).toHaveLength(1);
  expect(hardKills[0]?.axis).toBe('sub_dispatches');
});

test('cost rollup includes descendants in the handoff tree', () => {
  insertHandoff(db, 'h-root-8', null);
  insertHandoff(db, 'h-child-8a', 'h-root-8');
  insertHandoff(db, 'h-child-8b', 'h-child-8a');

  insertUsageUpdate(db, { eventId: 'u-8-root', handoffId: 'h-root-8', costUsd: 0.25 });
  insertUsageUpdate(db, { eventId: 'u-8-a', handoffId: 'h-child-8a', costUsd: 0.5 });
  insertUsageUpdate(db, { eventId: 'u-8-b', handoffId: 'h-child-8b', costUsd: 1.25 });

  expect(rollupCostForChain(db, 'h-root-8')).toBe(200);
  expect(rollupCostForChain(db, 'h-child-8a')).toBe(175);
});

test('terminated sessions are ignored on next tick', () => {
  seedTask(db, 'task-9');
  startSession(sessions, {
    taskId: 'task-9',
    chainHandoffId: 'h-root-9',
    wallClockBudgetMs: 10_000,
  });
  sessions.terminate('task-9', 'completed');

  const softWarns: MaestroSessionRecord[] = [];
  const hardKills: Array<{ session: MaestroSessionRecord; axis: BoundsAxis }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    onSoftWarn: (session) => softWarns.push(session),
    onHardKill: (session, axis) => hardKills.push({ session, axis }),
  });

  nowMs = 12_000;
  tracker.tick();

  expect(softWarns).toHaveLength(0);
  expect(hardKills).toHaveLength(0);
});

test('each tick logs session count', () => {
  seedTask(db, 'task-10');
  startSession(sessions, { taskId: 'task-10', chainHandoffId: 'h-root-10', wallClockBudgetMs: 10_000 });

  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    log: {
      info: (obj, msg) => logs.push({ obj, msg }),
      warn: () => {},
    },
    onSoftWarn: () => {},
    onHardKill: () => {},
  });

  tracker.tick();

  expect(logs).toHaveLength(1);
  expect(logs[0]?.msg).toBe('maestro bounds-tracker tick');
  expect(logs[0]?.obj).toEqual({ session_count: 1 });
});

test('soft warning failures are logged and do not crash the tick loop', () => {
  seedTask(db, 'task-11');
  startSession(sessions, { taskId: 'task-11', chainHandoffId: 'h-root-11', wallClockBudgetMs: 10_000 });

  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => nowMs,
    log: {
      info: () => {},
      warn: (obj, msg) => logs.push({ obj, msg }),
    },
    onSoftWarn: () => {
      throw new Error('inject blew up');
    },
    onHardKill: () => {},
  });

  nowMs = 8_000;
  expect(() => tracker.tick()).not.toThrow();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.msg).toBe('maestro bounds-tracker soft warning failed');
  expect(logs[0]?.obj).toMatchObject({ task_id: 'task-11', err: 'inject blew up' });
});
