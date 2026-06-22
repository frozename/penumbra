import { handleLongLivedInjectGoal } from "@penumbra/mcp/tools/long-lived-inject-goal";
import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedLongLivedAgent } from "./long-lived-fixtures.js";

interface PendingGoal {
  kind: string;
  text: string;
  created_at: number;
}

interface PersistedWorkingMemory {
  pending_goals?: PendingGoal[];
  open_threads?: { id: string; topic: string; opened_at: number; notes: string }[];
  updated_at?: number;
}

interface SelectRow {
  status: string;
  schedule_cron: string | null;
  working_memory_json: string;
}

function readWorkingMemory(db: Database, id: string): PersistedWorkingMemory {
  const row = db
    .query<
      { working_memory_json: string },
      [string]
    >("SELECT working_memory_json FROM long_lived_agents WHERE id=?")
    .get(id);
  if (!row) {
    throw new Error(`agent_not_found:${id}`);
  }
  return JSON.parse(row.working_memory_json) as PersistedWorkingMemory;
}

function noopFireTick(): void {
  // no-op stand-in for tests that do not assert fireTick behaviour
}

describe("long_lived_inject_goal", () => {
  it("appends a user_goal to pending_goals", () => {
    const db = new Database(":memory:");
    seedLongLivedAgent(db, { name: "a", standing_brief: "x" });
    const fireTick = mock(noopFireTick);

    const result = handleLongLivedInjectGoal(
      db,
      { fireTick, now: () => 5 },
      { id: "a", goal: "check the dryer" },
    );

    expect(result.ok).toBe(true);
    const wm = readWorkingMemory(db, "a");
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals?.[0]).toMatchObject({ kind: "user_goal", text: "check the dryer" });
    expect(fireTick).not.toHaveBeenCalled();
  });

  it("fires an injected_goal tick when the agent has no schedule", () => {
    const db = new Database(":memory:");
    seedLongLivedAgent(db, { name: "a", standing_brief: "x", schedule_cron: null });
    const fireTick = mock(noopFireTick);

    handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: "a", goal: "do thing" });

    expect(fireTick).toHaveBeenCalledTimes(1);
    expect(fireTick).toHaveBeenCalledWith({ agent_id: "a", trigger_kind: "injected_goal" });
  });

  it("rejects retired agents", () => {
    const db = new Database(":memory:");
    seedLongLivedAgent(db, { name: "a", standing_brief: "x", schedule_cron: "*/1 * * * *" });
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();

    expect(() =>
      handleLongLivedInjectGoal(
        db,
        { fireTick: noopFireTick, now: () => 5 },
        { id: "a", goal: "x" },
      ),
    ).toThrow(/not_active/);
  });

  it("acquires the write lock so a concurrent writer cannot slip in between SELECT and UPDATE", () => {
    // Two connections to the same WAL-mode file DB. Without BEGIN IMMEDIATE on
    // the inject's transaction, a separate connection could write its own
    // merged working_memory_json between our SELECT and our UPDATE and have
    // its data clobbered. With BEGIN IMMEDIATE the inject holds the write
    // lock from its SELECT onward, so the racing UPDATE on the second
    // connection fails fast (SQLITE_BUSY) and is forced to retry against the
    // post-inject row — no loss.
    const dir = mkdtempSync(join(tmpdir(), "penumbra-inject-goal-tx-"));
    const dbPath = join(dir, "test.sqlite");
    try {
      const writer = new Database(dbPath);
      const racer = new Database(dbPath);
      seedLongLivedAgent(writer, { name: "a", standing_brief: "x" });
      // Set busy_timeout=0 on the racer so its contended write fails
      // immediately rather than blocking the single JS thread.
      racer.run("PRAGMA busy_timeout = 0");
      writer.run("PRAGMA busy_timeout = 5000");

      let raceAttempts = 0;
      let raceErrors = 0;
      const originalQuery = writer.query.bind(writer);
      type StatementWithGet = ReturnType<typeof originalQuery> & {
        get: (...args: unknown[]) => unknown;
      };
      // Monkey-patch bun:sqlite's Database.query so we can intercept the
      // single SELECT that drives the race. bun-types marks `query` as a
      // method, so `as unknown as` is the genuine library-type gap that
      // lets us substitute a spy.
      const patchableWriter = writer as unknown as {
        query: (sql: string) => StatementWithGet;
      };
      patchableWriter.query = (sql: string): StatementWithGet => {
        const stmt = originalQuery(sql) as StatementWithGet;
        if (sql.startsWith("SELECT status, schedule_cron, working_memory_json")) {
          const originalGet = stmt.get.bind(stmt);
          stmt.get = (...gargs: unknown[]): unknown => {
            const row = originalGet(...gargs) as SelectRow;
            if (raceAttempts === 0) {
              raceAttempts += 1;
              // Try to land a competing write from a separate connection.
              try {
                const wm = JSON.parse(row.working_memory_json) as PersistedWorkingMemory;
                wm.open_threads = [{ id: "t1", topic: "x", opened_at: 2, notes: "n" }];
                wm.updated_at = 2;
                racer
                  .query(
                    "UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?",
                  )
                  .run(JSON.stringify(wm), 2, "a");
              } catch {
                raceErrors += 1;
              }
            }
            return row;
          };
        }
        return stmt;
      };

      handleLongLivedInjectGoal(
        writer,
        { fireTick: noopFireTick, now: () => 5 },
        { id: "a", goal: "do thing" },
      );

      expect(raceAttempts).toBe(1);
      // The fix means the racer must have been blocked by the inject's
      // BEGIN IMMEDIATE write lock. Without the fix, the racer would have
      // succeeded and then been clobbered by inject's UPDATE.
      expect(raceErrors).toBe(1);

      const wm = readWorkingMemory(racer, "a");
      expect(wm.pending_goals ?? []).toHaveLength(1);
      expect(wm.pending_goals?.[0]).toMatchObject({ kind: "user_goal", text: "do thing" });

      writer.close();
      racer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
