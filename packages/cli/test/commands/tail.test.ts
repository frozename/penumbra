import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTail } from "@src/commands/tail.js";

interface T0Input {
  ts: string;
  event_type?: string;
  source?: string;
  project_id?: string | null;
  session_id?: string | null;
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  latency_ms?: number | null;
  payload_summary?: string | null;
}

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-tail-"));
  dbPath = join(dir, "db.sqlite");
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seedT0(rows: T0Input[]): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.run(`
      CREATE TABLE t0_events(
        ts TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        model TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        latency_ms INTEGER,
        payload_summary TEXT
      )
    `);
    const insert = db.query(
      `INSERT INTO t0_events(ts, event_type, source, project_id, session_id, model,
                             tokens_in, tokens_out, latency_ms, payload_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.ts,
        row.event_type ?? "tool_call",
        row.source ?? "claude",
        row.project_id ?? null,
        row.session_id ?? null,
        row.model ?? null,
        row.tokens_in ?? null,
        row.tokens_out ?? null,
        row.latency_ms ?? null,
        row.payload_summary ?? null,
      );
    }
  } finally {
    db.close();
  }
}

test("runTail: limit >= row count returns rows oldest-first despite the DESC query", () => {
  seedT0([
    { ts: "2026-01-01T00:00:01Z" },
    { ts: "2026-01-01T00:00:03Z" },
    { ts: "2026-01-01T00:00:02Z" },
  ]);
  const rows = runTail({ dbPath, project: null, limit: 10 });
  expect(rows.map((r) => r.ts)).toEqual([
    "2026-01-01T00:00:01Z",
    "2026-01-01T00:00:02Z",
    "2026-01-01T00:00:03Z",
  ]);
});

test("runTail: limit keeps the newest N rows, still oldest-first", () => {
  seedT0([
    { ts: "2026-01-01T00:00:01Z" },
    { ts: "2026-01-01T00:00:02Z" },
    { ts: "2026-01-01T00:00:03Z" },
    { ts: "2026-01-01T00:00:04Z" },
    { ts: "2026-01-01T00:00:05Z" },
  ]);
  const rows = runTail({ dbPath, project: null, limit: 2 });
  expect(rows.map((r) => r.ts)).toEqual(["2026-01-01T00:00:04Z", "2026-01-01T00:00:05Z"]);
});

test("runTail: non-null project keeps only rows with that project_id", () => {
  seedT0([
    { ts: "2026-01-01T00:00:01Z", project_id: "alpha" },
    { ts: "2026-01-01T00:00:02Z", project_id: "beta" },
    { ts: "2026-01-01T00:00:03Z", project_id: null },
  ]);
  const rows = runTail({ dbPath, project: "alpha", limit: 10 });
  expect(rows.map((r) => r.ts)).toEqual(["2026-01-01T00:00:01Z"]);
});

test("runTail: null project applies no filter, including NULL project_id rows", () => {
  seedT0([
    { ts: "2026-01-01T00:00:01Z", project_id: "alpha" },
    { ts: "2026-01-01T00:00:02Z", project_id: "beta" },
    { ts: "2026-01-01T00:00:03Z", project_id: null },
  ]);
  const rows = runTail({ dbPath, project: null, limit: 10 });
  expect(rows.map((r) => r.ts)).toEqual([
    "2026-01-01T00:00:01Z",
    "2026-01-01T00:00:02Z",
    "2026-01-01T00:00:03Z",
  ]);
});

test("runTail: each row exposes exactly the 10 TailRow keys with the inserted values", () => {
  seedT0([
    {
      ts: "2026-01-01T00:00:01Z",
      event_type: "session_end",
      source: "gemini",
      project_id: "alpha",
      session_id: "s-1",
      model: "gemini-pro",
      tokens_in: 10,
      tokens_out: 20,
      latency_ms: 30,
      payload_summary: "hello",
    },
  ]);
  const rows = runTail({ dbPath, project: null, limit: 10 });
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    ts: "2026-01-01T00:00:01Z",
    event_type: "session_end",
    source: "gemini",
    project_id: "alpha",
    session_id: "s-1",
    model: "gemini-pro",
    tokens_in: 10,
    tokens_out: 20,
    latency_ms: 30,
    payload_summary: "hello",
  });
});

test("runTail: missing db path throws and does not create the file (readonly open)", () => {
  const missing = join(dir, "nope.sqlite");
  expect(() => {
    runTail({ dbPath: missing, project: null, limit: 10 });
  }).toThrow();
  expect(existsSync(missing)).toBe(false);
});
