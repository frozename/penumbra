import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { finalizeCycleAsCrashed } from "@src/dreaming/cycle-crash.js";

interface CycleRow {
  outcome: string;
  bail_reason: string | null;
  ended_at: number | null;
}

function openDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE dream_cycles (cycle_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL DEFAULT 'running', bail_reason TEXT)`,
  );
  return db;
}

function insertCycle(
  db: Database,
  cycleId: string,
  fields: { outcome?: string; ended_at?: number | null; bail_reason?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO dream_cycles (cycle_id, started_at, ended_at, outcome, bail_reason) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    cycleId,
    1000,
    fields.ended_at ?? null,
    fields.outcome ?? "running",
    fields.bail_reason ?? null,
  );
}

function readCycle(db: Database, cycleId: string): CycleRow {
  return db
    .prepare(`SELECT outcome, bail_reason, ended_at FROM dream_cycles WHERE cycle_id = ?`)
    .get(cycleId) as CycleRow;
}

describe("finalizeCycleAsCrashed", () => {
  test("marks a running cycle crashed with the error message as bail_reason", () => {
    const db = openDb();
    insertCycle(db, "cycle-1");

    finalizeCycleAsCrashed(db, "cycle-1", new Error("registry unavailable"));

    const row = readCycle(db, "cycle-1");
    expect(row.outcome).toBe("crashed");
    expect(row.bail_reason).toBe("phase_error: registry unavailable");
  });

  test("moves ended_at from NULL to a number", () => {
    const db = openDb();
    insertCycle(db, "cycle-1");
    expect(readCycle(db, "cycle-1").ended_at).toBeNull();

    finalizeCycleAsCrashed(db, "cycle-1", new Error("boom"));

    expect(typeof readCycle(db, "cycle-1").ended_at).toBe("number");
  });

  test("stringifies a non-Error err into the bail_reason", () => {
    const db = openDb();
    insertCycle(db, "cycle-1");

    finalizeCycleAsCrashed(db, "cycle-1", "boom");

    expect(readCycle(db, "cycle-1").bail_reason).toBe("phase_error: boom");
  });

  test("leaves an already completed cycle untouched", () => {
    const db = openDb();
    insertCycle(db, "cycle-1", { outcome: "completed", ended_at: 123 });

    finalizeCycleAsCrashed(db, "cycle-1", new Error("late failure"));

    expect(readCycle(db, "cycle-1")).toEqual({
      outcome: "completed",
      bail_reason: null,
      ended_at: 123,
    });
  });

  test("updates only the targeted cycle_id", () => {
    const db = openDb();
    insertCycle(db, "cycle-1");
    insertCycle(db, "cycle-2");

    finalizeCycleAsCrashed(db, "cycle-1", new Error("boom"));

    expect(readCycle(db, "cycle-2")).toEqual({
      outcome: "running",
      bail_reason: null,
      ended_at: null,
    });
  });

  test("an unknown cycle_id does not throw and leaves other rows untouched", () => {
    const db = openDb();
    insertCycle(db, "cycle-1");

    expect(() => {
      finalizeCycleAsCrashed(db, "cycle-missing", new Error("boom"));
    }).not.toThrow();

    expect(readCycle(db, "cycle-1")).toEqual({
      outcome: "running",
      bail_reason: null,
      ended_at: null,
    });
  });
});
