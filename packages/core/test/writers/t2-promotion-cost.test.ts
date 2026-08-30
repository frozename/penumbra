import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { TestEmbedder } from "@src/testing/index.js";
import { type T2MemoryExtraction, T2Promotion } from "@src/writers/t2.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

describe("T2Promotion cost gates", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  function seedRollup(rollupId: string, sessionId: string, origin: string | null = null): void {
    db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                               n_events, lane_breakdown_json, provider_breakdown_json, origin)
       VALUES (?, ?, 'u1', ?, '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}', ?)`,
      [rollupId, "proj", sessionId, origin],
    );
  }

  function seedTranscript(sessionId: string, content: string): void {
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
       VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
      [`e-${sessionId}-1`, "2026-04-27T10:00:00Z", "2026-04-27T10:00:00Z", sessionId, content],
    );
  }

  test("skips sub-minimum transcripts and promotes the rollup", async () => {
    seedRollup("r-short", "s-short");
    seedTranscript("s-short", "Ping");
    let called = false;

    const prom = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: (): string => "m-short",
      llm: (): Promise<T2MemoryExtraction[]> => {
        called = true;
        return Promise.resolve([]);
      },
    });

    const count = await prom.promoteRollup("r-short");
    expect(count).toBe(0);
    expect(called).toBe(false);
    const row = db
      .query<
        { t2_promoted_at: string | null },
        [string]
      >("SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id=?")
      .get("r-short")!;
    expect(row.t2_promoted_at).toBe("2026-04-27T15:00:00.000Z");
  });

  test("truncates long transcripts before the llm call", async () => {
    seedRollup("r-long", "s-long");
    seedTranscript("s-long", `${"a".repeat(10_000)}${"b".repeat(10_000)}${"c".repeat(2_000)}`);
    let seenTranscript = "";

    const prom = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: (): string => "m-long",
      llm: (transcript: string): Promise<T2MemoryExtraction[]> => {
        seenTranscript = transcript;
        return Promise.resolve([]);
      },
    });

    const count = await prom.promoteRollup("r-long");
    expect(count).toBe(0);
    expect(seenTranscript.length).toBeLessThan(20_000);
    expect(seenTranscript).toContain("… [truncated] …");
    expect(seenTranscript.startsWith("User: " + "a".repeat(7994))).toBe(true);
    expect(seenTranscript.endsWith("c".repeat(2000))).toBe(true);
  });

  test("allows the first repeated high-frequency transcript after the threshold", async () => {
    const originalRandom = Math.random;
    Math.random = (): number => 0.1;
    try {
      let called = 0;
      const prom = new T2Promotion({
        db,
        embedder: new TestEmbedder({ dim: 384 }),
        clock: (): Date => new Date("2026-04-27T15:00:00Z"),
        uuid: (): string => "m-sample",
        llm: (): Promise<T2MemoryExtraction[]> => {
          called++;
          return Promise.resolve([]);
        },
      });

      for (let i = 1; i <= 6; i++) {
        seedRollup(`r-${String(i)}`, `s-${String(i)}`, "maestro");
        seedTranscript(
          `s-${String(i)}`,
          "This is a normal length transcript with enough signal to hit the sampling gate. " +
            "x".repeat(220),
        );
        await prom.promoteRollup(`r-${String(i)}`);
      }

      expect(called).toBe(6);
      const row = db
        .query<
          { t2_promoted_at: string | null },
          [string]
        >("SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id=?")
        .get("r-6")!;
      expect(row.t2_promoted_at).toBe("2026-04-27T15:00:00.000Z");
    } finally {
      Math.random = originalRandom;
    }
  });
});
