import { expect, test, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services,
  migrate,
  loadSqliteVec,
  HandoffWriter,
  HandoffReader,
} from '@penumbra/core';
import { runStaleHandoffSweep, type StaleHandoffSweeperOpts } from '../../src/sweepers/stale-handoff.js';
import { enqueueMemoryVerifyJob } from '../../src/workers/handoff-sweeper.js';
import {
  resolveStaleAfterMs,
  resolveSweeperSqlCutoffMs,
} from '../../src/sweepers/stale-handoff-thresholds.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function setupDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  return {
    db,
    handoffWriter: new HandoffWriter({ db }),
    handoffReader: new HandoffReader({ db }),
    t0Writer: { write: () => {} },
    machineId: { get: () => 'machine-test' },
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    clock: () => new Date(),
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

function insertDispatchedHandoff(
  db: Database,
  handoff_id: string,
  ts: string,
  chainTaskType: string | null = null,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree, chain_task_type
     ) VALUES (?, ?, NULL, ?, 'maestro', 'worker', NULL, 'do work', 'dispatched', 1, ?)`,
    [handoff_id, ts, `c-${handoff_id}`, chainTaskType],
  );
}

function insertEvent(db: Database, handoff_id: string, kind: string, ts: string): void {
  db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', ?, ?, NULL)`,
    [handoff_id, kind, ts],
  );
}

function insertMemory(db: Database, memoryId: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      null,
      'u1',
      'fact',
      '[]',
      '2026-05-04T11:50:00.000Z',
      '2026-05-04T11:50:00.000Z',
      memoryId,
      'body',
      '{}',
      null,
      '2026-05-04T11:50:00.000Z',
      '2026-05-04T11:50:00.000Z',
    ],
  );
}

function insertMemoryRecallInjectedEvent(db: Database, handoff_id: string, ts: string, memoryId: string): void {
  db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', 'memory_recall_injected', ?, ?)`,
    [handoff_id, ts, JSON.stringify({ memory_id: memoryId })],
  );
}

function makeOpts(services: Services): StaleHandoffSweeperOpts {
  return { services };
}

function makeTaskTypeAwareOpts(services: Services): StaleHandoffSweeperOpts {
  return {
    services,
    resolveStaleAfterMs,
  };
}

test('no handoffs → empty candidates and resolved', () => {
  const db = setupDb();
  const services = makeServices(db);
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );
  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test('fresh dispatched handoff → not a candidate', () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 30 seconds ago; smoke-test threshold is 5 min and default is 15 min.
  insertDispatchedHandoff(db, 'h-fresh', '2026-05-04T11:59:30.000Z');
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );
  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test('stale dispatched handoff with no dispatch.end → force-resolved', () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 10 minutes ago, no dispatch.end.
  insertDispatchedHandoff(db, 'h-wedged', '2026-05-04T11:50:00.000Z');
  insertEvent(db, 'h-wedged', 'dispatch.start', '2026-05-04T11:50:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-wedged']);
  expect(result.resolved).toEqual(['h-wedged']);

  const endRow = db
    .query<{ kind: string; source: string; meta_json: string | null }, [string]>(
      `SELECT kind, source, meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end'`,
    )
    .get('h-wedged');
  expect(endRow).not.toBeNull();
  expect(endRow!.source).toBe('sweeper');
  expect(JSON.parse(endRow!.meta_json ?? '{}').reason).toBe('stale_force_resolve');

  const handoff = services.handoffReader.get('h-wedged');
  expect(handoff?.status).toBe('failed');
  expect(handoff?.resolution_reason).toBe('stale_force_resolve');
  expect(handoff?.resolved_by).toBe('stale-handoff-sweeper');
});

test('review_adversarial handoff at 29m59s old is not swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-review', '2026-05-04T11:30:01.000Z', 'review_adversarial');
  insertEvent(db, 'h-review', 'dispatch.start', '2026-05-04T11:40:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
  expect(services.handoffReader.get('h-review')?.status).toBe('dispatched');
});

test('smoke_test handoff at 5m01s old is swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-smoke', '2026-05-04T11:54:59.000Z', 'smoke_test');
  insertEvent(db, 'h-smoke', 'dispatch.start', '2026-05-04T11:54:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-smoke']);
  expect(result.resolved).toEqual(['h-smoke']);
});

test('implement_small handoff at 15m01s old is swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-small', '2026-05-04T11:44:59.000Z', 'implement_small');
  insertEvent(db, 'h-small', 'dispatch.start', '2026-05-04T11:44:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-small']);
  expect(result.resolved).toEqual(['h-small']);
});

test('smoke_test handoff at 4m59s old is not swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-smoke-fresh', '2026-05-04T11:55:01.000Z', 'smoke_test');
  insertEvent(db, 'h-smoke-fresh', 'dispatch.start', '2026-05-04T11:55:02.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test('review_adversarial handoff at 30m01s old is swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-review-old', '2026-05-04T11:29:59.000Z', 'review_adversarial');
  insertEvent(db, 'h-review-old', 'dispatch.start', '2026-05-04T11:30:00.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-review-old']);
  expect(result.resolved).toEqual(['h-review-old']);
});

test('memory verify auto-fire caps work per tick', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-verify-cap', '2026-05-04T11:50:00.000Z');
  for (let i = 0; i < 200; i++) {
    insertMemory(db, `m-${i}`);
    insertMemoryRecallInjectedEvent(db, 'h-verify-cap', '2026-05-04T11:50:00.000Z', `m-${i}`);
  }

  const priorCap = process.env.PENUMBRA_MEMORY_VERIFY_MAX_PER_TICK;
  process.env.PENUMBRA_MEMORY_VERIFY_MAX_PER_TICK = '50';
  try {
    const result = enqueueMemoryVerifyJob({
      services,
      handoffId: 'h-verify-cap',
      verdict: 'passed',
      verdictSummary: 'ok',
    });

    expect(result.memories_in_prompt).toBe(50);
    const count = db.query<{ c: number }, []>(
      `SELECT COUNT(*) AS c FROM t2_memory_verification_events`,
    ).get();
    expect(count?.c).toBe(50);
  } finally {
    if (priorCap === undefined) {
      delete process.env.PENUMBRA_MEMORY_VERIFY_MAX_PER_TICK;
    } else {
      process.env.PENUMBRA_MEMORY_VERIFY_MAX_PER_TICK = priorCap;
    }
  }
});

test('implement_small handoff at 14m59s old is not swept', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-small-fresh', '2026-05-04T11:45:01.000Z', 'implement_small');
  insertEvent(db, 'h-small-fresh', 'dispatch.start', '2026-05-04T11:45:02.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeTaskTypeAwareOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test('resolveSweeperSqlCutoffMs uses the smallest configured threshold for function resolvers', () => {
  expect(resolveSweeperSqlCutoffMs(resolveStaleAfterMs)).toBe(5 * 60_000);
  expect(resolveSweeperSqlCutoffMs(15 * 60_000)).toBe(15 * 60_000);
});

test('constant resolveStaleAfterMs still behaves like a fixed threshold', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-constant', '2026-05-04T11:44:00.000Z', 'review_adversarial');
  insertEvent(db, 'h-constant', 'dispatch.start', '2026-05-04T11:44:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, resolveStaleAfterMs: 15 * 60_000 },
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-constant']);
  expect(result.resolved).toEqual(['h-constant']);
});

test('deprecated staleAfterMs alias still works and warns once', () => {
  const db = setupDb();
  const services = makeServices(db);
  const warn = mock(() => {});
  insertDispatchedHandoff(db, 'h-alias', '2026-05-04T11:44:00.000Z', 'review_adversarial');
  insertEvent(db, 'h-alias', 'dispatch.start', '2026-05-04T11:44:01.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, staleAfterMs: 15 * 60_000, log: { warn } },
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-alias']);
  expect(result.resolved).toEqual(['h-alias']);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    { option: 'staleAfterMs' },
    'staleAfterMs is deprecated; use resolveStaleAfterMs instead',
  );
});

test('stale dispatched but dispatch.end already present → not resolved', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-end-present', '2026-05-04T11:50:00.000Z');
  insertEvent(db, 'h-end-present', 'dispatch.start', '2026-05-04T11:50:01.000Z');
  insertEvent(db, 'h-end-present', 'dispatch.end', '2026-05-04T11:55:00.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.candidates).toEqual(['h-end-present']);
  expect(result.resolved).toEqual([]);

  const handoff = services.handoffReader.get('h-end-present');
  expect(handoff?.status).toBe('dispatched');
});

test('stale handoff with recent agent activity is NOT force-resolved', () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 6 minutes ago (past 5min default threshold), but emitting events recently.
  insertDispatchedHandoff(db, 'h-active', '2026-05-04T11:54:00.000Z');
  insertEvent(db, 'h-active', 'dispatch.start', '2026-05-04T11:54:01.000Z');
  insertEvent(db, 'h-active', 'agent.thought', '2026-05-04T11:59:30.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    { services, activityIdleMs: 90_000 },
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );

  expect(result.resolved).toEqual([]);

  const handoff = services.handoffReader.get('h-active');
  expect(handoff?.status).toBe('dispatched');
});

test('cooldown holds → second sweep does not re-process the same handoff', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertDispatchedHandoff(db, 'h-cool', '2026-05-04T11:50:00.000Z');

  const state = { lastSwept: new Map<string, number>() };
  const first = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );
  expect(first.resolved).toEqual(['h-cool']);

  // Second tick within the cooldown window: same handoff already failed,
  // and even if it were still dispatched, the cooldown would skip it.
  // Re-insert as dispatched to prove the cooldown branch fires (independent of status).
  db.run(
    `UPDATE handoffs SET status='dispatched', resolved_at=NULL, resolved_by=NULL, resolution_reason=NULL WHERE handoff_id='h-cool'`,
  );

  const second = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:30.000Z'),
  );
  expect(second.candidates).toEqual([]);
  expect(second.resolved).toEqual([]);
});
