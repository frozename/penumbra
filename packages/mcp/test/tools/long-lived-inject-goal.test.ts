import { describe, it, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedInjectGoal } from "@penumbra/mcp/tools/long-lived-inject-goal";

function seed(db: Database, scheduleCron: string | null) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "a",
        long_lived: true,
        long_lived_config: {
          schedule_cron: scheduleCron ?? undefined,
          subscriptions: [],
          mcp_allowlist: [],
          bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "x",
        },
      } as any,
    ],
    { now: 1 },
  );
}

describe("long_lived_inject_goal", () => {
  it("appends a user_goal to pending_goals", async () => {
    const db = new Database(":memory:");
    seed(db, "*/15 * * * *");
    const fireTick = mock(() => {});

    const result = await handleLongLivedInjectGoal(
      db,
      { fireTick, now: () => 5 },
      { id: "a", goal: "check the dryer" },
    );

    expect(result.ok).toBe(true);
    const wm = JSON.parse(
      (db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any)
        .working_memory_json,
    );
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0]).toMatchObject({ kind: "user_goal", text: "check the dryer" });
    expect(fireTick).not.toHaveBeenCalled();
  });

  it("fires an injected_goal tick when the agent has no schedule", async () => {
    const db = new Database(":memory:");
    seed(db, null);
    const fireTick = mock(() => {});

    await handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: "a", goal: "do thing" });

    expect(fireTick).toHaveBeenCalledTimes(1);
    expect(fireTick).toHaveBeenCalledWith({ agent_id: "a", trigger_kind: "injected_goal" });
  });

  it("rejects retired agents", async () => {
    const db = new Database(":memory:");
    seed(db, "*/1 * * * *");
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();

    await expect(
      handleLongLivedInjectGoal(db, { fireTick: () => {}, now: () => 5 }, { id: "a", goal: "x" }),
    ).rejects.toThrow(/not_active/);
  });

  it("acquires the write lock so a concurrent writer cannot slip in between SELECT and UPDATE", async () => {
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
      seed(writer, "*/15 * * * *");
      // Set busy_timeout=0 on the racer so its contended write fails
      // immediately rather than blocking the single JS thread.
      racer.exec("PRAGMA busy_timeout = 0");
      writer.exec("PRAGMA busy_timeout = 5000");

      let raceAttempts = 0;
      let raceErrors = 0;
      const originalQuery = writer.query.bind(writer);
      (writer as any).query = (sql: string) => {
        const stmt = originalQuery(sql);
        if (sql.startsWith("SELECT status, schedule_cron, working_memory_json")) {
          const originalGet = stmt.get.bind(stmt);
          stmt.get = (...gargs: unknown[]) => {
            const row = originalGet(...(gargs as [])) as any;
            if (raceAttempts === 0) {
              raceAttempts += 1;
              // Try to land a competing write from a separate connection.
              try {
                const wm = JSON.parse(row.working_memory_json);
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

      await handleLongLivedInjectGoal(
        writer,
        { fireTick: () => {}, now: () => 5 },
        { id: "a", goal: "do thing" },
      );

      expect(raceAttempts).toBe(1);
      // The fix means the racer must have been blocked by the inject's
      // BEGIN IMMEDIATE write lock. Without the fix, the racer would have
      // succeeded and then been clobbered by inject's UPDATE.
      expect(raceErrors).toBe(1);

      const wm = JSON.parse(
        (racer.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any)
          .working_memory_json,
      );
      expect(wm.pending_goals ?? []).toHaveLength(1);
      expect(wm.pending_goals[0]).toMatchObject({ kind: "user_goal", text: "do thing" });

      writer.close();
      racer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
