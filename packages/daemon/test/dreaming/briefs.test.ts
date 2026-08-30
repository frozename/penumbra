import type { DreamConfig } from "@src/dreaming/config.js";

import { applySchema, loadSqliteVec } from "@penumbra/core";
import { type DreamCycleDeps, runDreamCycle } from "@src/dreaming/cycle.js";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

// File-local typed placeholder for DreamConfig — this test exercises only the
// handful of fields set inline below; DreamConfig's 30+ env-derived knobs would
// dwarf the test body if stubbed by hand. ONE documented `as unknown as`.
function makeDreamConfig(overrides: Partial<DreamConfig>): DreamConfig {
  return overrides as unknown as DreamConfig;
}

interface BriefRow {
  project_id: string;
  brief_md: string;
  t2_shadow_memory_id: string;
}

describe("P6: Brief Refresh", () => {
  test("P6 brief refresh calls memory_observe not direct SQL", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryObserveMock = mock((): Promise<{ memory_id: string }> => {
      db.prepare(
        "INSERT INTO t2_memories(memory_id, project_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at) VALUES('mem1', 'proj1', 'test_user', 'brief', 'ws', 'we', 'title', 'body', 'now', 'now')",
      ).run();
      return Promise.resolve({ memory_id: "mem1" });
    });

    const deps: DreamCycleDeps = {
      projectRegistry: {
        get: (_id: string) => null,
        list: () => [{ project_id: "proj1", dreaming: {} }],
      },
      memoryObserve: memoryObserveMock,
      briefSynthesizer: {
        synthesize: () =>
          Promise.resolve({
            markdown: "# Project Brief: proj1\nReal brief",
            source_memory_ids: [],
          }),
      },
    };

    await runDreamCycle(
      db,
      makeDreamConfig({
        enabled: true,
        cronMinutes: 30,
        perCycleUsd: 10,
        dailyUsd: 10,
        pressureGuardEnabled: false,
        p1BatchSize: 10,
        linkAutoThreshold: 0.9,
      }),
      deps,
    );

    expect(memoryObserveMock.mock.calls.length).toBe(1);
    const briefs = db.prepare("SELECT * FROM project_briefs").all() as BriefRow[];
    expect(briefs.length).toBe(1);
    expect(briefs[0]!.t2_shadow_memory_id).toBe("mem1");
  });
});
