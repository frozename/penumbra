import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionEventsRetentionWorker } from "@src/workers/session-events-retention.js";

type TimeoutCallback = (...args: unknown[]) => void;

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function insertSessionEvent(db: Database, sessionId: string, ts: string): void {
  db.run(
    `INSERT INTO session_events(session_id, kind, ts, meta_json)
     VALUES(?, 'session.start', ?, NULL)`,
    [sessionId, ts],
  );
}

test("prunes rows older than retentionDays in batches, stops at a partial batch, yields between batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-session-events-retention-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-10T00:00:00.000Z"),
  });
  const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
  let yieldCount = 0;
  const yields: number[] = [];
  globalThis.setTimeout = ((handler: TimeoutCallback, timeout?: number, ...args: unknown[]) => {
    yieldCount += 1;
    yields.push(timeout ?? 0);
    queueMicrotask(() => {
      handler(...args);
    });
    return 0 as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    for (let i = 0; i < 5; i += 1) {
      insertSessionEvent(db, `old-${String(i)}`, "2026-04-01T00:00:00.000Z");
    }
    insertSessionEvent(db, "recent", "2026-05-09T00:00:00.000Z");

    const worker = createSessionEventsRetentionWorker({
      services,
      retentionDays: 14,
      batchSize: 2,
    });
    await worker.tick();

    const rows = db
      .query<{ session_id: string }, []>("SELECT session_id FROM session_events ORDER BY id")
      .all();
    expect(rows).toEqual([{ session_id: "recent" }]);
    expect(yieldCount).toBe(2);
    expect(yields).toEqual([50, 50]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention caps each tick and reports backlog remaining", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-session-events-retention-cap-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-10T00:00:00.000Z"),
  });
  const infoSpy = spyOn(services.log, "info").mockImplementation(() => undefined);
  const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimeoutCallback, _timeout?: number, ...args: unknown[]) => {
    queueMicrotask(() => {
      handler(...args);
    });
    return 0 as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const insertOld = db.transaction((count: number) => {
      for (let i = 0; i < count; i += 1) {
        insertSessionEvent(db, `old-${String(i)}`, "2026-04-01T00:00:00.000Z");
      }
    });
    insertOld(100_001);
    insertSessionEvent(db, "recent", "2026-05-09T00:00:00.000Z");

    const worker = createSessionEventsRetentionWorker({
      services,
      retentionDays: 14,
      batchSize: 60_000,
    });
    await worker.tick();

    const oldRemaining = db
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM session_events WHERE ts < '2026-04-26T00:00:00.000Z'")
      .get();
    expect(oldRemaining?.count).toBe(1);
    expect(
      infoSpy.mock.calls.some((call) => {
        const meta = call[0];
        return (
          typeof meta === "object" &&
          meta !== null &&
          "remaining" in meta &&
          call[1] === "session-events retention: backlog remains for next tick"
        );
      }),
    ).toBe(true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    infoSpy.mockRestore();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
