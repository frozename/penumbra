import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";

import { p4MemoryByProjectSql } from "@src/dreaming/cycle.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const NOW_MS = 1_800_000_000_000;
const CUTOFF_MS = NOW_MS - 24 * 60 * 60 * 1000;
const PROJ_A = "proj-a";
const PROJ_B = "proj-b";

// Pre-change statement kept verbatim as the semantic oracle.
const ORACLE_PROJECT_SQL = `SELECT
   memory_id,
   title,
   SUBSTR(body, 1, 200) AS body,
   updated_at,
   (
     SELECT MAX(COALESCE(da.decided_at, ?2))
     FROM dream_actions da
     WHERE da.phase='P4'
       AND da.action_type='research_query'
       AND json_extract(da.payload_json, '$.source_memory_id') = t2_memories.memory_id
       AND COALESCE(da.decided_at, ?2) > ?3
   ) AS last_researched_at
 FROM t2_memories
 WHERE project_id = ?1
   AND kind NOT IN ('brief')
   AND retired_at IS NULL
   AND title IS NOT NULL
   AND title != ''
 ORDER BY last_researched_at IS NOT NULL ASC, last_researched_at ASC, created_at DESC
 LIMIT 2`;

const ORACLE_FALLBACK_SQL = `SELECT
   memory_id,
   title,
   SUBSTR(body, 1, 200) AS body,
   updated_at,
   (
     SELECT MAX(COALESCE(da.decided_at, ?1))
     FROM dream_actions da
     WHERE da.phase='P4'
       AND da.action_type='research_query'
       AND json_extract(da.payload_json, '$.source_memory_id') = t2_memories.memory_id
       AND COALESCE(da.decided_at, ?1) > ?2
   ) AS last_researched_at
 FROM t2_memories
 WHERE kind NOT IN ('brief')
   AND retired_at IS NULL
   AND title IS NOT NULL
   AND title != ''
 ORDER BY last_researched_at IS NOT NULL ASC, last_researched_at ASC, created_at DESC
 LIMIT 2`;

type MemoryRow = {
  memory_id: string;
  title: string;
  body: string;
  updated_at: string;
  last_researched_at: number | null;
};

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

// Mirrors the pre-project_id schema the hasT2ProjectId=false branch serves.
function openLegacyDb(): Database {
  const db = openTestDb();
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND tbl_name='t2_memories' AND sql LIKE '%project_id%'`,
    )
    .all() as { name: string }[];
  for (const { name } of indexes) {
    db.run(`DROP INDEX ${name}`);
  }
  db.run(`ALTER TABLE t2_memories DROP COLUMN project_id`);
  return db;
}

type SeedMemory = {
  id: string;
  title: string;
  projectId?: string;
  kind?: string;
  retired?: boolean;
  createdAt: string;
};

function seedMemory(db: Database, mem: SeedMemory, withProjectId: boolean): void {
  const retiredAt = mem.retired ? NOW_MS : null;
  const kind = mem.kind ?? "knowledge";
  const body = `body of ${mem.id}`;
  if (withProjectId) {
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id, retired_at)
       VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, ?, ?, ?, ?)`,
    ).run(
      mem.id,
      kind,
      mem.title,
      body,
      mem.createdAt,
      mem.createdAt,
      mem.projectId ?? null,
      retiredAt,
    );
    return;
  }
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, retired_at)
     VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, ?, ?, ?)`,
  ).run(mem.id, kind, mem.title, body, mem.createdAt, mem.createdAt, retiredAt);
}

type SeedAction = {
  id: string;
  phase?: string;
  actionType?: string;
  status?: string;
  memoryId?: string;
  decidedAt?: number | null;
};

function seedDreamAction(db: Database, action: SeedAction): void {
  const payload: Record<string, unknown> = { query: `q-${action.id}` };
  if (action.memoryId !== undefined) payload.source_memory_id = action.memoryId;
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, decided_at)
     VALUES(?, 'cycle-seed', ?, ?, 0.5, ?, '["proj-a"]', ?, ?)`,
  ).run(
    action.id,
    action.phase ?? "P4",
    action.actionType ?? "research_query",
    action.status ?? "completed",
    JSON.stringify(payload),
    action.decidedAt ?? null,
  );
}

// Expected ranking for proj-a: m-null (never researched) then m-old (oldest
// in-window recency). The legacy variant pools all projects, so the two
// unresearched memories sort by created_at DESC: m-b then m-null.
function seedRecencyFixture(db: Database, withProjectId: boolean): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome)
     VALUES('cycle-seed', ?, 'cron', 1.0, 'completed')`,
  ).run(NOW_MS);

  const mem = (m: SeedMemory): void => {
    seedMemory(db, m, withProjectId);
  };
  mem({
    id: "m-null",
    title: "Alpha memory never researched",
    projectId: PROJ_A,
    createdAt: "2026-01-01T00:00:00Z",
  });
  mem({
    id: "m-old",
    title: "Alpha memory researched earliest in window",
    projectId: PROJ_A,
    createdAt: "2026-01-02T00:00:00Z",
  });
  mem({
    id: "m-recent",
    title: "Alpha memory researched most recently",
    projectId: PROJ_A,
    createdAt: "2026-01-03T00:00:00Z",
  });
  mem({
    id: "m-retired",
    title: "Alpha retired memory",
    projectId: PROJ_A,
    retired: true,
    createdAt: "2026-01-04T00:00:00Z",
  });
  mem({
    id: "m-brief",
    title: "Alpha brief memory",
    projectId: PROJ_A,
    kind: "brief",
    createdAt: "2026-01-05T00:00:00Z",
  });
  mem({ id: "m-empty", title: "", projectId: PROJ_A, createdAt: "2026-01-06T00:00:00Z" });
  mem({
    id: "m-b",
    title: "Bravo memory never researched",
    projectId: PROJ_B,
    createdAt: "2026-02-01T00:00:00Z",
  });

  seedDreamAction(db, { id: "a-old-in", memoryId: "m-old", decidedAt: CUTOFF_MS + 500 });
  seedDreamAction(db, { id: "a-old-edge", memoryId: "m-old", decidedAt: CUTOFF_MS });
  seedDreamAction(db, { id: "a-old-older", memoryId: "m-old", decidedAt: CUTOFF_MS - 5_000 });

  seedDreamAction(db, { id: "a-recent-null", memoryId: "m-recent", decidedAt: null });
  seedDreamAction(db, { id: "a-recent-in", memoryId: "m-recent", decidedAt: CUTOFF_MS + 2_000 });
  seedDreamAction(db, { id: "a-recent-out", memoryId: "m-recent", decidedAt: CUTOFF_MS - 1_000 });

  seedDreamAction(db, { id: "a-null-p1", phase: "P1", memoryId: "m-null", decidedAt: NOW_MS });
  seedDreamAction(db, {
    id: "a-null-link",
    actionType: "link",
    memoryId: "m-null",
    decidedAt: NOW_MS,
  });

  seedDreamAction(db, { id: "a-no-source" });
  seedDreamAction(db, {
    id: "a-orphan",
    status: "failed",
    memoryId: "mem-missing",
    decidedAt: NOW_MS,
  });
}

function seedNumericSourceAction(
  db: Database,
  actionId: string,
  payload: string,
  decidedAt: number,
): void {
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, decided_at)
     VALUES(?, 'cycle-seed', 'P4', 'research_query', 0.5, 'completed', '["proj-a"]', ?, ?)`,
  ).run(actionId, payload, decidedAt);
}

function seedNumericTextFixture(db: Database, withProjectId: boolean): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome)
     VALUES('cycle-seed', ?, 'cron', 1.0, 'completed')`,
  ).run(NOW_MS);
  seedMemory(
    db,
    {
      id: "7",
      title: "Numeric-sourced memory",
      projectId: PROJ_A,
      createdAt: "2026-01-01T00:00:00Z",
    },
    withProjectId,
  );
  seedMemory(
    db,
    {
      id: "8",
      title: "Never researched memory",
      projectId: PROJ_A,
      createdAt: "2026-01-02T00:00:00Z",
    },
    withProjectId,
  );
  seedNumericSourceAction(db, "a-int", '{"query":"q-int","source_memory_id":7}', CUTOFF_MS + 500);
  seedNumericSourceAction(
    db,
    "a-text",
    '{"query":"q-text","source_memory_id":"7"}',
    CUTOFF_MS + 2_000,
  );
}

it("P4 project variant returns the same ranked memories as the correlated-subquery oracle", () => {
  const db = openTestDb();
  seedRecencyFixture(db, true);

  const expected = db.prepare(ORACLE_PROJECT_SQL).all(PROJ_A, NOW_MS, CUTOFF_MS) as MemoryRow[];
  const actual = db
    .prepare(p4MemoryByProjectSql(true))
    .all(PROJ_A, NOW_MS, CUTOFF_MS) as MemoryRow[];

  expect(actual).toEqual(expected);
  expect(actual.map((row) => row.memory_id)).toEqual(["m-null", "m-old"]);
  expect(actual[0]?.last_researched_at).toBeNull();
  expect(actual[1]?.last_researched_at).toBe(CUTOFF_MS + 500);
});

it("P4 legacy variant returns the same ranked memories as the correlated-subquery oracle", () => {
  const db = openLegacyDb();
  seedRecencyFixture(db, false);

  const expected = db.prepare(ORACLE_FALLBACK_SQL).all(NOW_MS, CUTOFF_MS) as MemoryRow[];
  const actual = db.prepare(p4MemoryByProjectSql(false)).all(NOW_MS, CUTOFF_MS) as MemoryRow[];

  expect(actual).toEqual(expected);
  expect(actual.map((row) => row.memory_id)).toEqual(["m-b", "m-null"]);
  expect(actual[0]?.last_researched_at).toBeNull();
  expect(actual[1]?.last_researched_at).toBeNull();
});

it("P4 project variant merges INTEGER and TEXT source_memory_id like the oracle", () => {
  const db = openTestDb();
  seedNumericTextFixture(db, true);

  const expected = db.prepare(ORACLE_PROJECT_SQL).all(PROJ_A, NOW_MS, CUTOFF_MS) as MemoryRow[];
  const actual = db
    .prepare(p4MemoryByProjectSql(true))
    .all(PROJ_A, NOW_MS, CUTOFF_MS) as MemoryRow[];

  expect(actual).toEqual(expected);
  expect(actual.map((row) => row.memory_id)).toEqual(["8", "7"]);
  expect(actual[0]?.last_researched_at).toBeNull();
  expect(actual[1]?.last_researched_at).toBe(CUTOFF_MS + 2_000);
});

it("P4 legacy variant merges INTEGER and TEXT source_memory_id like the oracle", () => {
  const db = openLegacyDb();
  seedNumericTextFixture(db, false);

  const expected = db.prepare(ORACLE_FALLBACK_SQL).all(NOW_MS, CUTOFF_MS) as MemoryRow[];
  const actual = db.prepare(p4MemoryByProjectSql(false)).all(NOW_MS, CUTOFF_MS) as MemoryRow[];

  expect(actual).toEqual(expected);
  expect(actual.map((row) => row.memory_id)).toEqual(["8", "7"]);
  expect(actual[0]?.last_researched_at).toBeNull();
  expect(actual[1]?.last_researched_at).toBe(CUTOFF_MS + 2_000);
});

it("P4 statement computes research recency without a correlated scalar subquery", () => {
  const db = openTestDb();

  for (const [sql, params] of [
    [p4MemoryByProjectSql(true), [PROJ_A, NOW_MS, CUTOFF_MS]],
    [p4MemoryByProjectSql(false), [NOW_MS, CUTOFF_MS]],
  ] as const) {
    const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
    expect(details).not.toContain("CORRELATED SCALAR SUBQUERY");
  }
});
