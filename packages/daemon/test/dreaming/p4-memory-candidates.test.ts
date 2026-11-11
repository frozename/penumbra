import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { p4MemoryCandidatesSql } from "@src/dreaming/p4-memory-candidates.js";

function database(projects = true): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t2_memories (
    memory_id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at TEXT,
    created_at TEXT, kind TEXT, retired_at TEXT${projects ? ", project_id TEXT" : ""});
    CREATE TABLE dream_actions (phase TEXT, action_type TEXT, decided_at INTEGER, payload_json TEXT)`);
  return db;
}

function memory(db: Database, id: string, created: string, project = "p"): void {
  const hasProject = db
    .query("PRAGMA table_info(t2_memories)")
    .all()
    .some((row) => (row as { name: string }).name === "project_id");
  db.query(`INSERT INTO t2_memories VALUES (?,?,?,?,?,?,?${hasProject ? ",?" : ""})`).run(
    ...[
      id,
      `Title ${id}`,
      "b".repeat(300),
      "updated",
      created,
      "fact",
      null,
      ...(hasProject ? [project] : []),
    ],
  );
}

function research(db: Database, id: string, at: number | null, phase = "P4"): void {
  db.query("INSERT INTO dream_actions VALUES (?, 'research_query', ?, ?)").run(
    phase,
    at,
    JSON.stringify({ source_memory_id: id }),
  );
}

test("P4 chooses unresearched memories first, then the least recently researched", () => {
  const db = database();
  try {
    for (const [id, date] of [
      ["old", "1"],
      ["new", "2"],
      ["recent", "3"],
      ["pending", "4"],
      ["other", "5"],
    ])
      memory(db, id!, date!, id === "other" ? "q" : "p");
    research(db, "recent", 900);
    research(db, "pending", null);
    research(db, "old", 100);
    research(db, "new", 500);
    const stmt = db.query<
      { memory_id: string; body: string; last_researched_at: number | null },
      [string, number, number]
    >(p4MemoryCandidatesSql(true));
    const initial = stmt.all("p", 1000, 500);
    expect(initial.map((row) => row.memory_id)).toEqual(["new", "old"]);
    expect(initial.map((row) => row.last_researched_at)).toEqual([null, null]);
    expect(initial[0]?.body).toHaveLength(200);
    research(db, "new", 800);
    research(db, "old", 700);
    research(db, "old", 850);
    expect(stmt.all("p", 1000, 500).map((row) => [row.memory_id, row.last_researched_at])).toEqual([
      ["new", 800],
      ["old", 850],
    ]);
  } finally {
    db.close();
  }
});

test("P4 filters briefs, retired/untitled memories and non-P4 history without per-memory subqueries", () => {
  const db = database();
  try {
    for (const id of ["valid", "blank", "retired", "brief", "missing"]) memory(db, id, id);
    db.run(
      "UPDATE t2_memories SET title='' WHERE memory_id='blank'; UPDATE t2_memories SET title=NULL WHERE memory_id='missing'; UPDATE t2_memories SET retired_at='now' WHERE memory_id='retired'; UPDATE t2_memories SET kind='brief' WHERE memory_id='brief'",
    );
    research(db, "valid", 999, "P3");
    const sql = p4MemoryCandidatesSql(true);
    expect(
      db
        .query<
          { memory_id: string; last_researched_at: number | null },
          [string, number, number]
        >(sql)
        .all("p", 1000, 500),
    ).toMatchObject([{ memory_id: "valid", last_researched_at: null }]);
    const plan = db
      .query<{ detail: string }, [string, number, number]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("p", 1000, 500);
    expect(plan.map((row) => row.detail).join("\n")).not.toContain("CORRELATED");
  } finally {
    db.close();
  }
});

test("legacy projectless P4 selection preserves shared ordering and parameters", () => {
  const db = database(false);
  try {
    memory(db, "a", "1");
    memory(db, "b", "2");
    memory(db, "c", "3");
    research(db, "c", null);
    expect(
      db
        .query<{ memory_id: string }, [number, number]>(p4MemoryCandidatesSql(false))
        .all(1000, 500)
        .map((row) => row.memory_id),
    ).toEqual(["b", "a"]);
  } finally {
    db.close();
  }
});
