import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applySchema } from "../src/db/schema.js";
import { loadSqliteVec } from "../src/db/sqlite-vec.js";
import { TestEmbedder } from "../src/embedder/test-embedder.js";
import { buildServices } from "../src/services.js";

describe("buildServices dispatchEventLog", () => {
  test("exposes dispatchEventLog wired to the same database", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);
    const services = buildServices({
      env: {},
      input: {},
      storageRoot: "/tmp/test-svc",
      db,
      embedder: new TestEmbedder({ dim: 384 }),
    });

    services.dispatchEventLog.record({
      handoff_id: "h-1",
      source: "daemon",
      kind: "watchdog.tick",
      ts: "2026-05-01T00:00:00.000Z",
    });

    expect(services.dispatchEventLog.listByHandoff("h-1")).toHaveLength(1);
    db.close();
  });
});
