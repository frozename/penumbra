import type { SQLQueryBindings } from "bun:sqlite";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  combineFilters,
  conceptFilter,
  dateFilter,
  type FilterContrib,
  projectFilter,
} from "@src/readers/filters/index.js";

describe("combineFilters", () => {
  test("empty contribs return 1=1 with no params", () => {
    expect(combineFilters([])).toEqual({ whereSql: "1=1", params: [] });
  });

  test("single contrib is wrapped in parentheses", () => {
    expect(combineFilters([{ sql: "a = ?", params: [1] }])).toEqual({
      whereSql: "(a = ?)",
      params: [1],
    });
  });

  test("multiple contribs join with AND in input order and flatten params", () => {
    const contribs: FilterContrib[] = [
      { sql: "x = ?", params: ["xv"] },
      projectFilter(null)!,
      { sql: "z = ?", params: ["zv"] },
    ];
    expect(combineFilters(contribs)).toEqual({
      whereSql: "(x = ?) AND (project_id IS NULL) AND (z = ?)",
      params: ["xv", "zv"],
    });
  });
});

describe("dateFilter", () => {
  test("returns null when both bounds are absent", () => {
    expect(dateFilter(undefined, undefined)).toBeNull();
    expect(dateFilter("", "")).toBeNull();
  });

  test("start-only uses >= bound", () => {
    expect(dateFilter("2026-01-01T00:00:00Z", undefined)).toEqual({
      sql: "created_at >= ?",
      params: ["2026-01-01T00:00:00Z"],
    });
  });

  test("end-only uses <= bound", () => {
    expect(dateFilter(undefined, "2026-12-31T23:59:59Z")).toEqual({
      sql: "created_at <= ?",
      params: ["2026-12-31T23:59:59Z"],
    });
  });

  test("both bounds use BETWEEN", () => {
    expect(dateFilter("2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z")).toEqual({
      sql: "created_at BETWEEN ? AND ?",
      params: ["2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z"],
    });
  });

  test("custom column replaces the default in each form", () => {
    expect(dateFilter("s", "e", "m.created_at")).toEqual({
      sql: "m.created_at BETWEEN ? AND ?",
      params: ["s", "e"],
    });
    expect(dateFilter("s", undefined, "m.created_at")).toEqual({
      sql: "m.created_at >= ?",
      params: ["s"],
    });
    expect(dateFilter(undefined, "e", "m.created_at")).toEqual({
      sql: "m.created_at <= ?",
      params: ["e"],
    });
  });
});

describe("projectFilter", () => {
  test("undefined returns null", () => {
    expect(projectFilter(undefined)).toBeNull();
  });

  test("null targets NULL project_id", () => {
    expect(projectFilter(null)).toEqual({ sql: "project_id IS NULL", params: [] });
  });

  test("string targets equality", () => {
    expect(projectFilter("p1")).toEqual({ sql: "project_id = ?", params: ["p1"] });
  });

  test("custom column replaces the default", () => {
    expect(projectFilter(null, "m.project_id")).toEqual({
      sql: "m.project_id IS NULL",
      params: [],
    });
    expect(projectFilter("p1", "m.project_id")).toEqual({
      sql: "m.project_id = ?",
      params: ["p1"],
    });
  });
});

describe("conceptFilter", () => {
  test("undefined and empty return null", () => {
    expect(conceptFilter(undefined)).toBeNull();
    expect(conceptFilter("")).toBeNull();
  });

  test("concept matches via LIKE concatenation", () => {
    expect(conceptFilter("auth")).toEqual({
      sql: "concepts LIKE '%' || ? || '%'",
      params: ["auth"],
    });
  });

  test("custom column replaces the default", () => {
    expect(conceptFilter("auth", "m.concepts")).toEqual({
      sql: "m.concepts LIKE '%' || ? || '%'",
      params: ["auth"],
    });
  });
});

function seedDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t (id TEXT, created_at TEXT, project_id TEXT NULL, concepts TEXT)`);
  db.run(
    `INSERT INTO t (id, created_at, project_id, concepts) VALUES
      ('a', '2026-01-01T00:00:00Z', 'p1', 'auth,login'),
      ('b', '2026-06-15T12:00:00Z', NULL, 'oauth,token'),
      ('c', '2026-06-15T12:00:00Z', 'p1', 'billing,invoice'),
      ('d', '2026-12-31T23:59:59Z', 'p2', 'network,auth')`,
  );
  return db;
}

function selectIds(db: Database, whereSql: string, params: SQLQueryBindings[]): string[] {
  const rows = db
    .query<{ id: string }, SQLQueryBindings[]>(`SELECT id FROM t WHERE ${whereSql} ORDER BY id`)
    .all(...params);
  return rows.map((r) => r.id);
}

describe("SQL semantics against an in-memory table", () => {
  const START = "2026-01-01T00:00:00Z";
  const END = "2026-12-31T23:59:59Z";

  test("BETWEEN form is inclusive at both bounds", () => {
    const db = seedDb();
    const contrib = dateFilter(START, END)!;
    const { whereSql, params } = combineFilters([contrib]);
    expect(selectIds(db, whereSql, params)).toEqual(["a", "b", "c", "d"]);
  });

  test(">= form is inclusive at the start bound", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([dateFilter("2026-06-15T12:00:00Z", undefined)!]);
    expect(selectIds(db, whereSql, params)).toEqual(["b", "c", "d"]);
  });

  test("<= form is inclusive at the end bound", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([dateFilter(undefined, "2026-06-15T12:00:00Z")!]);
    expect(selectIds(db, whereSql, params)).toEqual(["a", "b", "c"]);
  });

  test("projectFilter(null) matches only NULL project rows", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([projectFilter(null)!]);
    expect(selectIds(db, whereSql, params)).toEqual(["b"]);
  });

  test("projectFilter(string) excludes NULL rows", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([projectFilter("p1")!]);
    expect(selectIds(db, whereSql, params)).toEqual(["a", "c"]);
  });

  test("conceptFilter matches a substring in the middle of the concepts string", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([conceptFilter("oau")!]);
    expect(selectIds(db, whereSql, params)).toEqual(["b"]);
  });

  test("combining narrowed filters gives the intersection", () => {
    const db = seedDb();
    const contribs = [
      projectFilter("p1"),
      dateFilter("2026-01-01T00:00:00Z", "2026-06-15T12:00:00Z"),
      conceptFilter("auth"),
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const { whereSql, params } = combineFilters(contribs);
    expect(selectIds(db, whereSql, params)).toEqual(["a"]);
  });

  test("combineFilters([]) returns every row", () => {
    const db = seedDb();
    const { whereSql, params } = combineFilters([]);
    expect(selectIds(db, whereSql, params)).toEqual(["a", "b", "c", "d"]);
  });
});
