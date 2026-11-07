import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runRoutingBiasListSource } from "@src/recall-sources/routing-bias-list.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function insertBias(
  db: Database,
  id: string,
  scope: "provider" | "agent",
  value: string,
  reason: string | null,
  createdAt: string,
  expiresAt: string,
): void {
  db.prepare(
    `INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, scope, value, "boost", 0.5, reason, createdAt, expiresAt);
}

function insertLiveRows(db: Database, count: number): void {
  const insert = db.prepare(
    `INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const tag = String(i);
      insert.run(
        `b-${tag}`,
        "agent",
        `v-${tag}`,
        "boost",
        0.5,
        "reason",
        "2026-05-04T10:00:00.000Z",
        "2026-05-04T18:00:00.000Z",
      );
    }
  })();
}

test("routing_bias_list defaults limit to 50 when no limit arg is given", () => {
  const db = freshDb();
  try {
    insertLiveRows(db, 51);
    const out = runRoutingBiasListSource({
      db,
      args: {},
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows).toHaveLength(50);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list caps limit at 500", () => {
  const db = freshDb();
  try {
    insertLiveRows(db, 501);
    const out = runRoutingBiasListSource({
      db,
      args: { limit: 1000 },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows).toHaveLength(500);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list raises limit 0 to 1", () => {
  const db = freshDb();
  try {
    insertLiveRows(db, 3);
    const out = runRoutingBiasListSource({
      db,
      args: { limit: 0 },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list falls back to limit 50 for a non-finite limit", () => {
  const db = freshDb();
  try {
    insertLiveRows(db, 51);
    const out = runRoutingBiasListSource({
      db,
      args: { limit: Number.POSITIVE_INFINITY },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows).toHaveLength(50);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list ignores an unknown scope", () => {
  const db = freshDb();
  try {
    insertBias(
      db,
      "b-provider",
      "provider",
      "v-provider",
      "reason",
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T18:00:00.000Z",
    );
    insertBias(
      db,
      "b-agent",
      "agent",
      "v-agent",
      "reason",
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T18:00:00.000Z",
    );
    const out = runRoutingBiasListSource({
      db,
      args: { scope: "model" },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows.map((row) => row.bias_id).sort()).toEqual(["b-agent", "b-provider"]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list keeps a null reason null", () => {
  const db = freshDb();
  try {
    insertBias(
      db,
      "b-null-reason",
      "agent",
      "v-null",
      null,
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T18:00:00.000Z",
    );
    const out = runRoutingBiasListSource({
      db,
      args: {},
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(out.rows[0]?.reason).toBeNull();
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list uses the injected now to decide expiry", () => {
  const db = freshDb();
  try {
    insertBias(
      db,
      "b-future",
      "agent",
      "v-future",
      "reason",
      "2999-01-01T00:00:00.000Z",
      "3000-01-01T00:00:00.000Z",
    );
    const out = runRoutingBiasListSource({
      db,
      args: {},
      now: () => new Date("3000-06-01T00:00:00.000Z"),
    });
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});
