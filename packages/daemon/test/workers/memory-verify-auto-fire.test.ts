import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { type Services, loadSqliteVec, migrate } from '@penumbra/core';
import { enqueueMemoryVerifyJob } from '../../src/workers/handoff-sweeper.js';

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
    handoffWriter: {
      markFailed: () => {},
    },
    handoffReader: {
      get: () => null,
    },
    t0Writer: { write: () => {} },
    machineId: { get: () => 'machine-test' },
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    clock: () => new Date('2026-05-16T12:00:00.000Z'),
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as Services;
}

function insertMemory(db: Database, memoryId: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at
    ) VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    [
      memoryId,
      '2026-05-16T11:00:00.000Z',
      '2026-05-16T11:30:00.000Z',
      memoryId,
      `${memoryId} body`,
      '2026-05-16T11:30:00.000Z',
      '2026-05-16T11:30:00.000Z',
    ],
  );
}

function insertHandoff(db: Database, handoffId: string, actor: string): void {
  db.run(
    `INSERT INTO handoffs(
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status,
      resolved_by, resolved_at, chain_task_type, use_worktree
    ) VALUES (?, ?, NULL, ?, 'maestro', ?, 'prompt', 'failed', 'lane-close', ?, 'implement_small', 1)`,
    [handoffId, '2026-05-16T11:59:00.000Z', `c-${handoffId}`, actor, '2026-05-16T12:00:00.000Z'],
  );
}

function insertInjectedEvent(db: Database, handoffId: string, memoryId: string): void {
  db.run(
    `INSERT INTO dispatch_events(
      handoff_id, worker_id, source, kind, ts, meta_json
    ) VALUES (?, NULL, 'worker', 'memory_recall_injected', ?, ?)`,
    [handoffId, '2026-05-16T11:59:30.000Z', JSON.stringify({ memory_id: memoryId })],
  );
}

test('auto-fire no-op when the lane has no injected memories', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertHandoff(db, 'h-empty', 'codex-acp-fast');

  const result = enqueueMemoryVerifyJob({
    services,
    handoffId: 'h-empty',
    verdict: 'passed',
    verdictSummary: 'passed',
  });

  expect(result.events_written).toBe(0);
  expect(result.events_skipped_idempotent).toBe(0);
  const rows = db.query(`SELECT * FROM t2_memory_verification_events`).all();
  expect(rows).toHaveLength(0);
});

test('auto-fire writes one verification event per injected memory', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertMemory(db, 'm-1');
  insertMemory(db, 'm-2');
  insertHandoff(db, 'h-many', 'codex-acp-fast');
  insertInjectedEvent(db, 'h-many', 'm-1');
  insertInjectedEvent(db, 'h-many', 'm-2');

  const result = enqueueMemoryVerifyJob({
    services,
    handoffId: 'h-many',
    verdict: 'failed',
    verdictSummary: 'failed',
  });

  expect(result.events_written).toBe(2);
  expect(result.events_skipped_idempotent).toBe(0);
  const rows = db.query<{
    memory_id: string;
    verifier_actor: string;
    claimed_by: string | null;
    reason: string | null;
    session_id: string | null;
  }, []>(
    `SELECT memory_id, verifier_actor, claimed_by, reason, session_id
     FROM t2_memory_verification_events
     ORDER BY memory_id ASC`,
  ).all();
  expect(rows).toEqual([
    {
      memory_id: 'm-1',
      verifier_actor: 'auto-lane-close',
      claimed_by: 'codex-acp-fast',
      reason: 'lane closed failed: failed',
      session_id: 'h-many',
    },
    {
      memory_id: 'm-2',
      verifier_actor: 'auto-lane-close',
      claimed_by: 'codex-acp-fast',
      reason: 'lane closed failed: failed',
      session_id: 'h-many',
    },
  ]);
});

test.each([
  ['passed', 1, 'lane closed passed: passed'],
  ['skipped', 0, null],
  ['review_debt', 0, null],
] as const)('auto-fire preserves verdict provenance for %s', (verdict, expectedWrites, expectedReason) => {
  const db = setupDb();
  const services = makeServices(db);
  insertMemory(db, `m-${verdict}`);
  insertHandoff(db, `h-${verdict}`, 'codex-acp-fast');
  insertInjectedEvent(db, `h-${verdict}`, `m-${verdict}`);

  const result = enqueueMemoryVerifyJob({
    services,
    handoffId: `h-${verdict}`,
    verdict,
    verdictSummary: verdict,
  });

  expect(result.events_written).toBe(expectedWrites);
  if (expectedReason !== null) {
    const row = db.query<{ reason: string | null }, [string]>(
      `SELECT reason FROM t2_memory_verification_events WHERE memory_id = ? AND session_id = ?`,
    ).get(`m-${verdict}`, `h-${verdict}`);
    expect(row?.reason).toBe(expectedReason);
  }
});

test.each(['skipped', 'review_debt'] as const)('auto-fire no-ops for verdict=%s', (verdict) => {
  const db = setupDb();
  const services = makeServices(db);
  insertMemory(db, `m-${verdict}`);
  insertHandoff(db, `h-${verdict}`, 'codex-acp-fast');
  insertInjectedEvent(db, `h-${verdict}`, `m-${verdict}`);

  const result = enqueueMemoryVerifyJob({
    services,
    handoffId: `h-${verdict}`,
    verdict,
    verdictSummary: verdict,
  });

  expect(result.events_written).toBe(0);
  expect(result.events_skipped_idempotent).toBe(0);
  expect(result.events_skipped_no_write).toBe(0);
  const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`).get();
  expect(count?.c).toBe(0);
});

test('auto-fire skips already-written verification events on rerun', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertMemory(db, 'm-3');
  insertMemory(db, 'm-4');
  insertHandoff(db, 'h-rerun', 'codex-acp-fast');
  insertInjectedEvent(db, 'h-rerun', 'm-3');
  insertInjectedEvent(db, 'h-rerun', 'm-4');

  const first = enqueueMemoryVerifyJob({
    services,
    handoffId: 'h-rerun',
    verdict: 'failed',
    verdictSummary: 'failed',
  });
  const second = enqueueMemoryVerifyJob({
    services,
    handoffId: 'h-rerun',
    verdict: 'failed',
    verdictSummary: 'failed',
  });

  expect(first.events_written).toBe(2);
  expect(second.events_written).toBe(0);
  expect(second.events_skipped_idempotent).toBe(2);
  const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`).get();
  expect(count?.c).toBe(2);
});

test('auto-fire counts missing memories as skipped no-write', () => {
  const db = setupDb();
  const services = makeServices(db);
  insertHandoff(db, 'h-missing', 'codex-acp-fast');
  insertInjectedEvent(db, 'h-missing', 'missing-memory');

  const result = enqueueMemoryVerifyJob({
    services,
    handoffId: 'h-missing',
    verdict: 'failed',
    verdictSummary: 'failed',
  });

  expect(result.events_written).toBe(0);
  expect(result.events_skipped_idempotent).toBe(0);
  expect(result.events_skipped_no_write).toBe(1);
  const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`).get();
  expect(count?.c).toBe(0);
});
