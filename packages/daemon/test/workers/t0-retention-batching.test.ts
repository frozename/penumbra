import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createT0RetentionWorker } from "@src/workers/t0-retention.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

const NOW = new Date("2026-04-23T12:00:00.000Z");
const RETENTION_DAYS = 30;
const THRESHOLD = new Date(NOW.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

// The legacy statement, kept verbatim as the oracle for what "the same set of
// rows" means. bun:sqlite reports changes including trigger side-effects, so
// the oracle runs to a fixpoint on the actual row count instead of trusting
// .changes.
const LEGACY_CONDITION =
  "(session_id IS NULL OR session_id IN (SELECT session_id FROM t1_rollups WHERE ended_at IS NOT NULL))";

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  const noop = (): void => undefined;
  return {
    db,
    clock: (): Date => new Date(NOW),
    log: { info: noop, warn: noop, error: noop },
  } as unknown as Services;
}

function insertEvent(db: Database, id: string, ingestTs: string, session: string | null): void {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id, event_type, lane, payload_json)
     VALUES(?, ?, ?, 'mcp', 'pA', 'u', 'm', ?, 'agent-prompt', 'local', '{}')`,
    [id, ingestTs, ingestTs, session],
  );
}

function insertRollup(db: Database, session: string, endedAt: string | null): void {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES(?, 'pA', 'u', ?, '2026-01-01T00:00:00Z', ?, 1, '{}', '{}')`,
    ["r_" + session, session, endedAt],
  );
}

function eventIds(db: Database): string[] {
  return db
    .query<{ event_id: string }, []>("SELECT event_id FROM t0_events ORDER BY event_id")
    .all()
    .map((r) => r.event_id);
}

function rowCount(db: Database): number {
  return db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t0_events").get()!.c;
}

// Runs the legacy unbounded-scan statement until it stops making progress.
function runLegacyOracle(db: Database, threshold: string, batchSize: number): void {
  const stmt = db.query(`
    DELETE FROM t0_events
    WHERE event_id IN (
      SELECT event_id FROM t0_events
      WHERE ingest_ts < ?1
        AND ${LEGACY_CONDITION}
      LIMIT ?2
    )
  `);
  for (;;) {
    const before = rowCount(db);
    stmt.run(threshold, batchSize);
    if (rowCount(db) === before) break;
  }
}

const OLD_TS = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
const RECENT_TS = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
const oldTs = (i: number): string => new Date(Date.parse(OLD_TS) + i * 1000).toISOString();

// Seeds a mixed shape: deletable rows (NULL session, ended-rollup session),
// retained rows (live session, recent rows), and a same-ingest_ts cluster to
// exercise the keyset cursor's tiebreak.
function seedMixed(db: Database): void {
  for (let i = 0; i < 12; i++)
    insertEvent(db, `live_${String(i)}`, oldTs(i), `s_live_${String(i % 3)}`);
  for (let i = 0; i < 8; i++) insertEvent(db, `ended_${String(i)}`, oldTs(20 + i), "s_done");
  for (let i = 0; i < 4; i++) insertEvent(db, `orphan_${String(i)}`, oldTs(30 + i), null);
  for (let i = 0; i < 3; i++) insertEvent(db, `recent_${String(i)}`, RECENT_TS, "s_done");
  for (let i = 0; i < 6; i++) {
    const session = i % 2 === 0 ? "s_done" : `s_tie_live_${String(i)}`;
    insertEvent(db, `tie_${String(i)}`, OLD_TS, session);
  }
  insertRollup(db, "s_done", OLD_TS);
  for (let i = 0; i < 3; i++) insertRollup(db, `s_live_${String(i)}`, null);
  for (let i = 0; i < 6; i += 2) insertRollup(db, `s_tie_live_${String(i)}`, null);
}

test("t0 retention deletes exactly the rows the legacy statement deletes", async () => {
  const oracleDb = setupDb();
  try {
    seedMixed(oracleDb);
    runLegacyOracle(oracleDb, THRESHOLD, 7);
    const expectedRemaining = eventIds(oracleDb);
    expect(expectedRemaining.length).toBeGreaterThan(0);

    const db = setupDb();
    try {
      seedMixed(db);
      const worker = createT0RetentionWorker({
        services: makeServices(db),
        retentionDays: RETENTION_DAYS,
        batchSize: 7,
      });
      await worker.tick();
      expect(eventIds(db)).toEqual(expectedRemaining);
    } finally {
      db.close();
    }
  } finally {
    oracleDb.close();
  }
});

test("t0 retention bounds every DELETE by batchSize and splits the scan across statements", async () => {
  const db = setupDb();
  try {
    // 23 below-threshold candidates (20 live + 3 deletable); batchSize 5.
    for (let i = 0; i < 20; i++)
      insertEvent(db, `live_${String(i)}`, oldTs(i), `s_live_${String(i % 4)}`);
    for (let i = 0; i < 3; i++) insertEvent(db, `ended_${String(i)}`, oldTs(30 + i), "s_done");
    insertRollup(db, "s_done", OLD_TS);
    for (let i = 0; i < 4; i++) insertRollup(db, `s_live_${String(i)}`, null);

    const deletedPerStatement: number[] = [];
    const origQuery = db.query.bind(db);
    db.query = ((sql: string, ...rest: unknown[]): ReturnType<typeof origQuery> => {
      const stmt = origQuery(sql, ...(rest as never[]));
      if (!/^\s*DELETE\s+FROM\s+t0_events/i.test(sql)) return stmt;
      const wrapped = stmt as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ["run", "all", "get"] as const) {
        const orig = wrapped[method].bind(stmt);
        wrapped[method] = (...args: unknown[]): unknown => {
          const before = rowCount(db);
          const out = orig(...args);
          deletedPerStatement.push(before - rowCount(db));
          return out;
        };
      }
      return stmt;
    }) as typeof db.query;

    const worker = createT0RetentionWorker({
      services: makeServices(db),
      retentionDays: RETENTION_DAYS,
      batchSize: 5,
    });
    await worker.tick();

    expect(deletedPerStatement.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...deletedPerStatement)).toBeLessThanOrEqual(5);
    expect(deletedPerStatement.reduce((a, b) => a + b, 0)).toBe(3);
  } finally {
    db.close();
  }
});

test("t0 retention yields to the event loop between batches", async () => {
  const db = setupDb();
  try {
    // 210 below-threshold candidates (200 live + 10 deletable); batchSize 100.
    for (let i = 0; i < 200; i++)
      insertEvent(db, `live_${String(i)}`, oldTs(i), `s_live_${String(i % 8)}`);
    for (let i = 0; i < 10; i++) insertEvent(db, `ended_${String(i)}`, oldTs(300 + i), "s_done");
    insertRollup(db, "s_done", OLD_TS);
    for (let i = 0; i < 8; i++) insertRollup(db, `s_live_${String(i)}`, null);

    const worker = createT0RetentionWorker({
      services: makeServices(db),
      retentionDays: RETENTION_DAYS,
      batchSize: 100,
    });

    let callbackRan = false;
    setImmediate(() => {
      callbackRan = true;
    });
    await worker.tick();
    expect(callbackRan).toBeTrue();
  } finally {
    db.close();
  }
});
