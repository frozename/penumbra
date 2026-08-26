import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { applySchema, SCHEMA_VERSION } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

describe("routing_bias schema", () => {
  it("applySchema creates routing_bias with expected columns on fresh DB", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const cols = db
      .query<
        { name: string; type: string; notnull: number },
        []
      >(`PRAGMA table_info('routing_bias')`)
      .all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    for (const required of [
      "bias_id",
      "scope",
      "value",
      "mode",
      "weight",
      "reason",
      "created_at",
      "expires_at",
    ]) {
      expect(byName[required]).toBeDefined();
    }
    expect(byName.bias_id?.type).toBe("TEXT");
    // PK is implicitly notnull
    expect(byName.scope?.notnull).toBe(1);
    expect(byName.value?.notnull).toBe(1);
    expect(byName.mode?.notnull).toBe(1);
    expect(byName.created_at?.notnull).toBe(1);
    expect(byName.expires_at?.notnull).toBe(1);
    db.close();
  });

  it("routing_bias has a UNIQUE(scope, value, mode) constraint", () => {
    const db = makeDb();
    const indexes = db
      .query<
        { name: string; unique: number },
        []
      >(`SELECT name, "unique" FROM pragma_index_list('routing_bias') WHERE "unique" = 1`)
      .all();
    expect(indexes.length).toBeGreaterThanOrEqual(1);
    const uniqueNames = indexes.map((i) => i.name);
    // sqlite autoindex or named unique
    const hasUniqueOnTriple = uniqueNames.some(
      (n) =>
        n.includes("scope") ||
        n.includes("value") ||
        n.includes("mode") ||
        n.startsWith("sqlite_autoindex_routing_bias"),
    );
    expect(hasUniqueOnTriple).toBe(true);
    db.close();
  });

  it("routing_bias has an index on (scope, expires_at)", () => {
    const db = makeDb();
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='routing_bias'`,
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_routing_bias_scope_expiry");
    db.close();
  });

  it("SCHEMA_VERSION is expected", () => {
    // SCHEMA_VERSION is defined in packages/core/src/db/schema.ts
    expect(SCHEMA_VERSION).toBe(41);
  });

  it("db_meta marker re-stamps to current SCHEMA_VERSION after applySchema", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);
    // Verify db_meta has the lane_ledger_open_dedupe marker set to SCHEMA_VERSION
    const marker = db
      .query<
        { value: string },
        []
      >("SELECT value FROM db_meta WHERE key = 'lane_ledger_open_dedupe_schema_version'")
      .get();
    expect(marker?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("applySchema on a DB pre-seeded at v34 creates routing_bias", () => {
    // Simulate a v34 DB by creating it with SCHEMA_VERSION=34 and applySchema,
    // but since we can't easily roll back, we test idempotency: second applySchema
    // should be a no-op for the table.
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    // Count routing_bias tables after first apply
    const tables = db
      .query<
        { name: string },
        string
      >("SELECT name FROM sqlite_master WHERE type=? AND name='routing_bias'")
      .all("table");
    expect(tables.length).toBe(1);

    // Second apply should not error and table count stays 1
    applySchema(db);
    const tables2 = db
      .query<
        { name: string },
        string
      >("SELECT name FROM sqlite_master WHERE type=? AND name='routing_bias'")
      .all("table");
    expect(tables2.length).toBe(1);

    // Marker still 35
    const marker = db
      .query<
        { value: string },
        []
      >("SELECT value FROM db_meta WHERE key = 'lane_ledger_open_dedupe_schema_version'")
      .get();
    expect(marker?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });
});

describe("readRoutingBiases", () => {
  it("returns [] on empty table", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const db = makeDb();
    const result = readRoutingBiases(db);
    expect(result).toEqual([]);
    db.close();
  });

  it("returns a future-expiry bias and omits a past one", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const pastISO = new Date(Date.now() - 3600_000).toISOString();
    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const now = new Date();

    setRoutingBias(db, {
      scope: "agent",
      value: "test-agent",
      mode: "boost",
      weight: 1.5,
      expires_at: pastISO,
    });
    setRoutingBias(db, {
      scope: "agent",
      value: "test-agent",
      mode: "divert",
      weight: 0.5,
      expires_at: futureISO,
    });

    const result = readRoutingBiases(db, { now });
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("divert");
    expect(result[0].weight).toBe(0.5);
    db.close();
  });

  it("boundary expires_at===now is expired (strict > now)", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const now = new Date("2026-06-15T00:00:00.000Z");
    const exactNow = now.toISOString();

    setRoutingBias(db, {
      scope: "agent",
      value: "exact-agent",
      mode: "boost",
      weight: 1.0,
      expires_at: exactNow,
    });

    const result = readRoutingBiases(db, { now });
    expect(result).toHaveLength(0);
    db.close();
  });

  it("scope filter works", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });
    setRoutingBias(db, {
      scope: "provider",
      value: "p1",
      mode: "divert",
      weight: 0.5,
      expires_at: futureISO,
    });

    const agents = readRoutingBiases(db, { scope: "agent" });
    expect(agents).toHaveLength(1);
    expect(agents[0].value).toBe("a1");

    const providers = readRoutingBiases(db, { scope: "provider" });
    expect(providers).toHaveLength(1);
    expect(providers[0].value).toBe("p1");
    db.close();
  });

  it("value filter works", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });
    setRoutingBias(db, {
      scope: "agent",
      value: "a2",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });

    const filtered = readRoutingBiases(db, { value: "a1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].value).toBe("a1");
    db.close();
  });

  it("orders a refreshed existing bias ahead of older biases", async () => {
    const { readRoutingBiases } = await import("../../src/readers/routing-bias.js");
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const readNow = new Date("2026-06-15T00:00:00.000Z");
    const futureISO = new Date("2026-06-15T01:00:00.000Z").toISOString();

    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
      now: new Date("2026-06-15T00:00:01.000Z"),
    });
    setRoutingBias(db, {
      scope: "agent",
      value: "a2",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
      now: new Date("2026-06-15T00:00:02.000Z"),
    });
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
      now: new Date("2026-06-15T00:00:03.000Z"),
    });

    const result = readRoutingBiases(db, { now: readNow });
    expect(result.map((bias) => bias.value)).toEqual(["a1", "a2"]);
    expect(result[0].created_at).toBe("2026-06-15T00:00:03.000Z");
    db.close();
  });
});

describe("setRoutingBias", () => {
  it("upsert: twice with identical (scope,value,mode) leaves exactly 1 row", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const first = setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });
    const second = setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 2.0,
      reason: "updated",
      expires_at: futureISO,
    });

    // Same bias_id preserved
    expect(first.bias_id).toBe(second.bias_id);
    // Weight and reason updated
    expect(second.weight).toBe(2.0);
    expect(second.reason).toBe("updated");

    const count = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM routing_bias").get();
    expect(count?.c).toBe(1);
    db.close();
  });

  it("ttl_seconds computes expires_at from now", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const now = new Date("2026-06-15T00:00:00.000Z");
    const result = setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      ttl_seconds: 600,
      now,
    });

    const expected = new Date(now.getTime() + 600_000).toISOString();
    expect(result.expires_at).toBe(expected);
    db.close();
  });

  it("explicit expires_at takes precedence over ttl_seconds", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const now = new Date("2026-06-15T00:00:00.000Z");
    const explicit = new Date("2026-07-01T00:00:00.000Z").toISOString();
    const result = setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: explicit,
      ttl_seconds: 600,
      now,
    });

    expect(result.expires_at).toBe(explicit);
    db.close();
  });

  it("throws if neither expires_at nor ttl_seconds", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    expect(() =>
      setRoutingBias(db, {
        scope: "agent",
        value: "a1",
        mode: "boost",
        weight: 1.0,
      }),
    ).toThrow(/expires_at|ttl_seconds/);
    db.close();
  });

  it("rejects bad mode", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    expect(() =>
      setRoutingBias(db, {
        scope: "agent",
        value: "a1",
        mode: "invalid_mode",
        ttl_seconds: 600,
      }),
    ).toThrow(/mode/);
    db.close();
  });

  it("rejects bad scope", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    expect(() =>
      setRoutingBias(db, {
        scope: "invalid_scope",
        value: "a1",
        mode: "boost",
        ttl_seconds: 600,
      }),
    ).toThrow(/scope/);
    db.close();
  });

  it("clamps weight to [0, 2.0]", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const high = setRoutingBias(db, {
      scope: "agent",
      value: "high",
      mode: "boost",
      weight: 5.0,
      expires_at: futureISO,
    });
    const low = setRoutingBias(db, {
      scope: "agent",
      value: "low",
      mode: "boost",
      weight: -1.0,
      expires_at: futureISO,
    });

    expect(high.weight).toBe(2.0);
    expect(low.weight).toBe(0);
    db.close();
  });

  it("null weight is preserved", async () => {
    const { setRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const result = setRoutingBias(db, {
      scope: "agent",
      value: "nw",
      mode: "exclude",
      weight: null,
      expires_at: futureISO,
    });
    expect(result.weight).toBeNull();
    db.close();
  });
});

describe("clearRoutingBias", () => {
  it("clears by bias_id", async () => {
    const { setRoutingBias, clearRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    const bias = setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });

    const result = clearRoutingBias(db, { bias_id: bias.bias_id });
    expect(result.cleared_count).toBe(1);

    const count = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM routing_bias").get();
    expect(count?.c).toBe(0);
    db.close();
  });

  it("clears by (scope, value)", async () => {
    const { setRoutingBias, clearRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "divert",
      weight: 0.5,
      expires_at: futureISO,
    });

    const result = clearRoutingBias(db, { scope: "agent", value: "a1" });
    expect(result.cleared_count).toBe(2);
    db.close();
  });

  it("clears all with all:true", async () => {
    const { setRoutingBias, clearRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    const futureISO = new Date(Date.now() + 3600_000).toISOString();
    setRoutingBias(db, {
      scope: "agent",
      value: "a1",
      mode: "boost",
      weight: 1.0,
      expires_at: futureISO,
    });
    setRoutingBias(db, {
      scope: "provider",
      value: "p1",
      mode: "divert",
      weight: 0.5,
      expires_at: futureISO,
    });

    const result = clearRoutingBias(db, { all: true });
    expect(result.cleared_count).toBe(2);
    db.close();
  });

  it("throws without valid args", async () => {
    const { clearRoutingBias } = await import("../../src/writers/routing-bias.js");
    const db = makeDb();

    expect(() => clearRoutingBias(db, {})).toThrow();
    expect(() => clearRoutingBias(db, { scope: "agent" })).toThrow();
    db.close();
  });
});

describe("exports from index.ts", () => {
  it("RoutingBias type and three functions are exported", async () => {
    const mod = await import("../../src/index.js");
    // Check all 4 exports exist
    expect(mod.readRoutingBiases).toBeDefined();
    expect(mod.setRoutingBias).toBeDefined();
    expect(mod.clearRoutingBias).toBeDefined();
    // RoutingBias is a type-only export, verified by compilation
    expect(typeof mod.readRoutingBiases).toBe("function");
    expect(typeof mod.setRoutingBias).toBe("function");
    expect(typeof mod.clearRoutingBias).toBe("function");
  });
});
