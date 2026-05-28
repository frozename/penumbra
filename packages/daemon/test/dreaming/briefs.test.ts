import { describe, test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { runDreamCycle } from "../../src/dreaming/cycle.js";

describe("P6: Brief Refresh", () => {
  test("P6 brief refresh calls memory_observe not direct SQL", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryObserveMock = mock(async () => {
      db.prepare(
        "INSERT INTO t2_memories(memory_id, project_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at) VALUES('mem1', 'proj1', 'test_user', 'brief', 'ws', 'we', 'title', 'body', 'now', 'now')",
      ).run();
      return { memory_id: "mem1" };
    });

    const deps = {
      projectRegistry: { list: () => [{ project_id: "proj1", dreaming: {} }] },
      memoryObserve: memoryObserveMock,
    };

    await runDreamCycle(
      db,
      {
        enabled: true,
        cronMinutes: 30,
        perCycleUsd: 10,
        dailyUsd: 10,
        pressureGuardEnabled: false,
        p1BatchSize: 10,
        linkAutoThreshold: 0.9,
      } as any,
      deps as any,
    );

    expect(memoryObserveMock.mock.calls.length).toBe(1);
    const briefs = db.prepare("SELECT * FROM project_briefs").all() as any[];
    expect(briefs.length).toBe(1);
    expect(briefs[0].t2_shadow_memory_id).toBe("mem1");
  });
});
