import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { applySchema, releaseT1RollupClaims } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

const CLAIMED_INDEX = "t1_claimed_idx";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function planDetails(db: Database, sql: string, params: (string | number | null)[]): string[] {
  return db
    .query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

// The UPDATE text below mirrors releaseT1RollupClaims' assembly; the drift pin
// at the bottom keeps it honest if the shipped builder moves.
function releaseUpdateSql(clauses: string[]): string {
  return `UPDATE t1_rollups
          SET claimed_at=NULL, claimed_by_cycle=NULL
        WHERE claimed_at IS NOT NULL
          AND (${clauses.join(" OR ")})`;
}

function claimReleaseVariants(): { label: string; sql: string; params: (string | number)[] }[] {
  return [
    {
      label: "terminal-outcome subquery (startup sweep)",
      sql: releaseUpdateSql([
        `claimed_by_cycle IN (SELECT cycle_id FROM dream_cycles WHERE outcome IN ('completed','crashed'))`,
      ]),
      params: [],
    },
    {
      label: "terminal-outcome subquery + staleBeforeMs (P1 hot path)",
      sql: releaseUpdateSql([
        `claimed_by_cycle IN (SELECT cycle_id FROM dream_cycles WHERE outcome IN (?,?))`,
        `claimed_at <= ?`,
      ]),
      params: ["completed", "crashed", 123],
    },
    {
      label: "cycleIds list",
      sql: releaseUpdateSql([`claimed_by_cycle IN (?,?)`]),
      params: ["c1", "c2"],
    },
    {
      label: "staleBeforeMs only",
      sql: releaseUpdateSql([`claimed_at <= ?`]),
      params: [123],
    },
    {
      label: "all three clause kinds",
      sql: releaseUpdateSql([
        `claimed_by_cycle IN (SELECT cycle_id FROM dream_cycles WHERE outcome IN (?))`,
        `claimed_at <= ?`,
        `claimed_by_cycle IN (?)`,
      ]),
      params: ["completed", 123, "c9"],
    },
  ];
}

test("claim release seeks the claimed partial index for every clause shape", () => {
  const db = freshDb();
  for (const { label, sql, params } of claimReleaseVariants()) {
    const details = planDetails(db, sql, params);
    expect(details, label).not.toContain("SCAN t1_rollups");
    expect(details.join(" "), label).toContain(CLAIMED_INDEX);
  }
});

test("claim release keeps the index after ANALYZE", () => {
  const db = freshDb();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, claimed_at, claimed_by_cycle)
     VALUES (?, 'u1', ?, '2026-01-01T00:00:00Z', 1, NULL, NULL)`,
  );
  for (let i = 0; i < 300; i++) insert.run(`r-${String(i)}`, `s-${String(i)}`);
  db.prepare(
    `UPDATE t1_rollups SET claimed_at = ?, claimed_by_cycle = 'c-live' WHERE rollup_id IN ('r-1','r-2','r-3')`,
  ).run(now);
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap,outcome) VALUES('c-live', ?, 'cron', 0.5, 'running')`,
  ).run(now);
  db.run("ANALYZE");
  for (const { label, sql, params } of claimReleaseVariants()) {
    const details = planDetails(db, sql, params);
    expect(details, label).not.toContain("SCAN t1_rollups");
    expect(details.join(" "), label).toContain(CLAIMED_INDEX);
  }
});

interface SeedRow {
  rollup_id: string;
  claimed_at: number | null;
  claimed_by_cycle: string | null;
}

function seedClaimMatrix(db: Database): { cycles: Map<string, string>; rows: SeedRow[] } {
  const now = 1_000_000;
  const cycles = new Map<string, string>([
    ["c-done", "completed"],
    ["c-crashed", "crashed"],
    ["c-running", "running"],
    ["c-failed", "failed"],
  ]);
  const insertCycle = db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,ended_at,trigger,budget_usd_cap,outcome) VALUES(?,?,?,?,?,?)`,
  );
  for (const [id, outcome] of cycles) {
    insertCycle.run(
      id,
      now - 10_000,
      outcome === "running" ? null : now - 9_000,
      "cron",
      0.5,
      outcome,
    );
  }

  const rows: SeedRow[] = [
    { rollup_id: "terminal-done", claimed_at: now - 500, claimed_by_cycle: "c-done" },
    { rollup_id: "terminal-crashed", claimed_at: now - 400, claimed_by_cycle: "c-crashed" },
    { rollup_id: "live-fresh", claimed_at: now - 50, claimed_by_cycle: "c-running" },
    { rollup_id: "live-stale", claimed_at: now - 70_000, claimed_by_cycle: "c-running" },
    { rollup_id: "failed-cycle", claimed_at: now - 600, claimed_by_cycle: "c-failed" },
    { rollup_id: "ghost-cycle", claimed_at: now - 800, claimed_by_cycle: "c-gone" },
    // claimed_by_cycle set without claimed_at is not a live lease.
    { rollup_id: "unclaimed-tagged", claimed_at: null, claimed_by_cycle: "c-done" },
    { rollup_id: "unclaimed", claimed_at: null, claimed_by_cycle: null },
  ];
  const insertRollup = db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, claimed_at, claimed_by_cycle)
     VALUES (?, 'u1', ?, '2026-01-01T00:00:00Z', 1, ?, ?)`,
  );
  for (const row of rows) {
    insertRollup.run(row.rollup_id, `s-${row.rollup_id}`, row.claimed_at, row.claimed_by_cycle);
  }
  return { cycles, rows };
}

function oracleRelease(
  rows: SeedRow[],
  cycles: Map<string, string>,
  opts: { terminalOutcomes?: string[]; staleBeforeMs?: number; cycleIds?: string[] },
): Set<string> {
  const terminal = new Set(opts.terminalOutcomes ?? []);
  const listed = new Set(opts.cycleIds ?? []);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.claimed_at === null) continue;
    const cycleOutcome =
      row.claimed_by_cycle === null ? undefined : cycles.get(row.claimed_by_cycle);
    const hitTerminal = cycleOutcome !== undefined && terminal.has(cycleOutcome);
    const hitStale = opts.staleBeforeMs !== undefined && row.claimed_at <= opts.staleBeforeMs;
    const hitListed = row.claimed_by_cycle !== null && listed.has(row.claimed_by_cycle);
    if (hitTerminal || hitStale || hitListed) out.add(row.rollup_id);
  }
  return out;
}

function assertedPostState(db: Database, rows: SeedRow[], expectedReleased: Set<string>): void {
  const state = new Map(
    db
      .query<{ rollup_id: string; claimed_at: number | null; claimed_by_cycle: string | null }, []>(
        `SELECT rollup_id, claimed_at, claimed_by_cycle FROM t1_rollups`,
      )
      .all()
      .map((r) => [r.rollup_id, r]),
  );
  for (const row of rows) {
    const after = state.get(row.rollup_id);
    if (expectedReleased.has(row.rollup_id)) {
      expect(after?.claimed_at, row.rollup_id).toBeNull();
      expect(after?.claimed_by_cycle, row.rollup_id).toBeNull();
    } else {
      expect(after?.claimed_at, row.rollup_id).toBe(row.claimed_at);
      expect(after?.claimed_by_cycle, row.rollup_id).toBe(row.claimed_by_cycle);
    }
  }
}

test("releaseT1RollupClaims releases exactly the oracle-selected rows for every clause shape", () => {
  const staleBefore = 1_000_000 - 60_000;
  const cases = [
    {
      label: "P1 hot path",
      opts: { terminalOutcomes: ["completed", "crashed"], staleBeforeMs: staleBefore },
    },
    { label: "startup sweep", opts: { terminalOutcomes: ["crashed"] } },
    { label: "cycleIds", opts: { cycleIds: ["c-running", "c-failed"] } },
    { label: "stale only", opts: { staleBeforeMs: staleBefore } },
    {
      label: "all three",
      opts: {
        terminalOutcomes: ["completed"],
        staleBeforeMs: staleBefore,
        cycleIds: ["c-running"],
      },
    },
    { label: "no clauses", opts: {} },
    { label: "empty arrays", opts: { terminalOutcomes: [], cycleIds: [] } },
  ];
  for (const { label, opts } of cases) {
    const db = freshDb();
    const { cycles, rows } = seedClaimMatrix(db);
    const released = releaseT1RollupClaims(db, opts);
    const expected = oracleRelease(rows, cycles, opts);
    // sqlite3_changes() rolls in the t1_fts update trigger's side-effects, so
    // the count overshoots the released-row count whenever rows are released.
    if (expected.size === 0) {
      expect(released, label).toBe(0);
    } else {
      expect(released, label).toBeGreaterThanOrEqual(expected.size);
    }
    assertedPostState(db, rows, expected);
    db.close();
  }
});

test("existing stores gain the claimed partial index on re-apply", () => {
  const db = freshDb();
  db.run(`DROP INDEX IF EXISTS ${CLAIMED_INDEX}`);
  applySchema(db, { embeddingDim: 384 });
  const name = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(CLAIMED_INDEX)?.name;
  expect(name).toBe(CLAIMED_INDEX);
});

test("the shipped UPDATE keeps the claimed_at-gated form the index covers", async () => {
  const schemaSource = await Bun.file(resolve(import.meta.dir, "../../src/db/schema.ts")).text();
  // The partial index only confines the scan when the head predicate stays
  // exactly `claimed_at IS NOT NULL`; the OR'd clauses are evaluated per claimed
  // row inside it.
  expect(schemaSource).toContain("WHERE claimed_at IS NOT NULL");
  expect(schemaSource).toContain('clauses.join(" OR ")');
});
