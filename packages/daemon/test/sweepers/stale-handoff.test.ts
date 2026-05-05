import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services,
  migrate,
  loadSqliteVec,
  HandoffWriter,
  HandoffReader,
} from '@penumbra/core';
import {
  runStaleHandoffSweep,
  type StaleHandoffSweeperOpts,
} from '../../src/sweepers/stale-handoff.js';

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
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree
     ) VALUES (?, ?, NULL, ?, 'maestro', 'worker', NULL, 'do work', 'dispatched', 1)`,
    [handoff_id, ts, `c-${handoff_id}`],
  );
}

function insertEvent(db: Database, handoff_id: string, kind: string, ts: string): void {
  db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', ?, ?, NULL)`,
    [handoff_id, kind, ts],
  );
}

function makeOpts(services: Services): StaleHandoffSweeperOpts {
  return { services };
}

test('no handoffs → empty candidates and resolved', () => {
  const db = setupDb();
  const services = makeServices(db);
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
    state,
    () => new Date('2026-05-04T12:00:00.000Z'),
  );
  expect(result.candidates).toEqual([]);
  expect(result.resolved).toEqual([]);
});

test('fresh dispatched handoff → not a candidate', () => {
  const db = setupDb();
  const services = makeServices(db);
  // Dispatched 30 seconds ago; default stale threshold is 5 min.
  insertDispatchedHandoff(db, 'h-fresh', '2026-05-04T11:59:30.000Z');
  const state = { lastSwept: new Map<string, number>() };
  const result = runStaleHandoffSweep(
    makeOpts(services),
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
