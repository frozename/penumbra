import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRecent } from "@src/commands/recent.js";

interface T1Input {
  rollup_id: string;
  started_at: string;
  ended_at?: string | null;
  project_id?: string | null;
  session_id?: string;
  n_events?: number;
  tokens_in_total?: number | null;
  tokens_out_total?: number | null;
  first_prompt_excerpt?: string | null;
  last_response_excerpt?: string | null;
}

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-recent-"));
  dbPath = join(dir, "db.sqlite");
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seedT1(rows: T1Input[]): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.run(`
      CREATE TABLE t1_rollups(
        rollup_id TEXT PRIMARY KEY,
        project_id TEXT,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        n_events INTEGER NOT NULL,
        tokens_in_total INTEGER,
        tokens_out_total INTEGER,
        first_prompt_excerpt TEXT,
        last_response_excerpt TEXT
      )
    `);
    const insert = db.query(
      `INSERT INTO t1_rollups(rollup_id, project_id, session_id, started_at, ended_at,
                              n_events, tokens_in_total, tokens_out_total,
                              first_prompt_excerpt, last_response_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.rollup_id,
        row.project_id ?? null,
        row.session_id ?? `s-${row.rollup_id}`,
        row.started_at,
        row.ended_at ?? null,
        row.n_events ?? 1,
        row.tokens_in_total ?? null,
        row.tokens_out_total ?? null,
        row.first_prompt_excerpt ?? null,
        row.last_response_excerpt ?? null,
      );
    }
  } finally {
    db.close();
  }
}

test("runRecent: ordering uses COALESCE(ended_at, started_at) DESC", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:09Z" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:05Z", ended_at: "2026-01-01T00:00:06Z" },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 10 });
  expect(rows.map((r) => r.rollup_id)).toEqual(["A", "B"]);
});

test("runRecent: a row with NULL ended_at sorts by its started_at", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:09Z" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:05Z", ended_at: "2026-01-01T00:00:06Z" },
    { rollup_id: "C", started_at: "2026-01-01T00:00:07Z", ended_at: null },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 10 });
  expect(rows.map((r) => r.rollup_id)).toEqual(["A", "C", "B"]);
});

test("runRecent: limit caps the count and keeps the most recent rows", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:05Z" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:02Z", ended_at: "2026-01-01T00:00:04Z" },
    { rollup_id: "C", started_at: "2026-01-01T00:00:03Z", ended_at: "2026-01-01T00:00:06Z" },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 2 });
  expect(rows.map((r) => r.rollup_id)).toEqual(["C", "A"]);
});

test("runRecent: non-null project filters by project_id", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", project_id: "alpha" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:02Z", project_id: "beta" },
    { rollup_id: "C", started_at: "2026-01-01T00:00:03Z", project_id: null },
  ]);
  const rows = runRecent({ dbPath, project: "alpha", limit: 10 });
  expect(rows.map((r) => r.rollup_id)).toEqual(["A"]);
});

test("runRecent: null project returns all rows", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", project_id: "alpha" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:02Z", project_id: "beta" },
    { rollup_id: "C", started_at: "2026-01-01T00:00:03Z", project_id: null },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 10 });
  expect(rows.map((r) => r.rollup_id)).toEqual(["C", "B", "A"]);
});

test("runRecent: a row exposes exactly the 10 RecentRow keys with the inserted values", () => {
  seedT1([
    {
      rollup_id: "r-1",
      project_id: "alpha",
      session_id: "s-1",
      started_at: "2026-01-01T00:00:01Z",
      ended_at: "2026-01-01T00:00:09Z",
      n_events: 7,
      tokens_in_total: 100,
      tokens_out_total: 200,
      first_prompt_excerpt: "first",
      last_response_excerpt: "last",
    },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 10 });
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    rollup_id: "r-1",
    project_id: "alpha",
    session_id: "s-1",
    started_at: "2026-01-01T00:00:01Z",
    ended_at: "2026-01-01T00:00:09Z",
    n_events: 7,
    tokens_in_total: 100,
    tokens_out_total: 200,
    first_prompt_excerpt: "first",
    last_response_excerpt: "last",
  });
});

test("runRecent: results are not reversed - element [0] is the most recent row", () => {
  seedT1([
    { rollup_id: "A", started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:05Z" },
    { rollup_id: "B", started_at: "2026-01-01T00:00:02Z", ended_at: "2026-01-01T00:00:08Z" },
  ]);
  const rows = runRecent({ dbPath, project: null, limit: 10 });
  expect(rows[0]?.rollup_id).toBe("B");
});
