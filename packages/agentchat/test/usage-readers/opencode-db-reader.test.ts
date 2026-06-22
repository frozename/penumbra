import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeDbReader } from "../../src/usage-readers/opencode-db-reader.js";

function makeOpencodeDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-db-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);",
  );
  return { db, path };
}

function insertAssistant(
  db: Database,
  id: string,
  time_created: number,
  body: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO message VALUES (?, "sess-1", ?, ?, ?)').run(
    id,
    time_created,
    time_created,
    JSON.stringify(body),
  );
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

describe("OpenCodeDbReader", () => {
  it("emits usage_deltas grouped by (provider, model) with cost_usd populated", async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, "m1", 1777421548000, {
      role: "assistant",
      cost: 0.0011,
      tokens: {
        total: 500,
        input: 100,
        output: 200,
        reasoning: 50,
        cache: { read: 100, write: 50 },
      },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });
    insertAssistant(db, "m2", 1777421549000, {
      role: "assistant",
      cost: 0.0013,
      tokens: {
        total: 600,
        input: 150,
        output: 250,
        reasoning: 60,
        cache: { read: 110, write: 30 },
      },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    const delta = first(r.usage_deltas);
    expect(delta.provider).toBe("opencode-go");
    expect(delta.model).toBe("deepseek-v4-pro");
    expect(delta.cost_usd).toBeCloseTo(0.0024, 4);
    expect(delta.tokens_input).toBe(250);
    expect(delta.tokens_output).toBe(450);
  });

  it("cursor advances by max time_created; second call returns nothing for same data", async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, "m1", 1777421548000, {
      role: "assistant",
      cost: 0.001,
      tokens: { input: 10, output: 20 },
      modelID: "x",
      providerID: "p",
    });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it("skips rows missing tokens", async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, "m1", 1777421548000, {
      role: "assistant",
      cost: 0,
      modelID: "x",
      providerID: "p",
    });
    insertAssistant(db, "m2", 1777421549000, {
      role: "assistant",
      cost: 0.5,
      tokens: { input: 1, output: 1 },
      modelID: "x",
      providerID: "p",
    });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(first(r.usage_deltas).tokens_input).toBe(1);
  });

  it("returns empty when db file is absent", async () => {
    const reader = new OpenCodeDbReader({ dbPath: "/tmp/no-such-opencode.db" });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(0);
  });

  it("read() does not throw when the source DB is locked", async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, "m1", 1777421548000, {
      role: "assistant",
      cost: 0.001,
      tokens: { input: 10, output: 20 },
      modelID: "x",
      providerID: "p",
    });
    db.close();

    const locker = new Database(path);
    locker.run("BEGIN EXCLUSIVE");

    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);

    expect(r.usage_deltas).toHaveLength(0);
    expect(r.rate_limit_snapshots).toHaveLength(0);
    expect(r.cursor).toEqual({ last_seen_time_created: 0 });

    locker.run("ROLLBACK");
    locker.close();
  });

  it("does not emit rate-limit snapshots from local API-equivalent message cost", async () => {
    const { db, path } = makeOpencodeDb();
    const nowMs = Date.now();

    // In 5h window: cost 3
    insertAssistant(db, "m1", nowMs - 1000 * 3600, {
      role: "assistant",
      cost: 3,
      tokens: { input: 1, output: 1 },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });

    // In 7d window (outside 5h): cost 6
    insertAssistant(db, "m2", nowMs - 1000 * 3600 * 10, {
      role: "assistant",
      cost: 6,
      tokens: { input: 1, output: 1 },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });

    // In 30d window (outside 7d): cost 15
    insertAssistant(db, "m3", nowMs - 1000 * 86400 * 10, {
      role: "assistant",
      cost: 15,
      tokens: { input: 1, output: 1 },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });

    db.close();

    const reader = new OpenCodeDbReader({ dbPath: path });

    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(0);
  });

  it("rollover math excludes old rows", async () => {
    const { db, path } = makeOpencodeDb();
    const nowMs = Date.now();

    // Older than 30d -> excluded entirely
    insertAssistant(db, "old", nowMs - 1000 * 86400 * 31, {
      role: "assistant",
      cost: 1000,
      tokens: { input: 1, output: 1 },
      modelID: "deepseek-v4-pro",
      providerID: "opencode-go",
    });

    db.close();

    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);

    expect(r.rate_limit_snapshots).toHaveLength(0);
  });
});
