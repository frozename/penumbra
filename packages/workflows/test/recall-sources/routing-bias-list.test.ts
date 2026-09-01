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

test("routing_bias_list returns an empty array and no warning on an empty DB", () => {
  const db = freshDb();
  try {
    const out = runRoutingBiasListSource({
      db,
      args: {},
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });

    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list orders mode severity then expiry and truncates reason", () => {
  const db = freshDb();
  try {
    const insert = db.prepare(
      `INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "b-boost",
      "agent",
      "codex-fast",
      "boost",
      0.5,
      "boost reason",
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T18:00:00.000Z",
    );
    insert.run(
      "b-exclude-later",
      "provider",
      "slow",
      "exclude",
      null,
      "x".repeat(200),
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T17:00:00.000Z",
    );
    insert.run(
      "b-exclude-earlier",
      "provider",
      "down",
      "exclude",
      null,
      "exclude earlier",
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T16:00:00.000Z",
    );
    insert.run(
      "b-divert",
      "agent",
      "legacy",
      "divert",
      null,
      "divert reason",
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T15:00:00.000Z",
    );

    const out = runRoutingBiasListSource({
      db,
      args: { limit: 3 },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
    });

    expect(out.rows.map((row) => row.bias_id)).toEqual([
      "b-exclude-earlier",
      "b-exclude-later",
      "b-divert",
    ]);
    expect(out.rows[1]?.reason).toHaveLength(160);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("routing_bias_list filters by scope and value and fails open on reader error", () => {
  const db = freshDb();
  try {
    db.run(
      `INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
       VALUES ('b-1', 'agent', 'codex-fast', 'exclude', NULL, 'reason', '2026-05-04T10:00:00.000Z', '2026-05-04T18:00:00.000Z')`,
    );
    expect(
      runRoutingBiasListSource({
        db,
        args: { scope: "agent", value: "codex-fast" },
        now: () => new Date("2026-05-04T12:00:00.000Z"),
      }).rows.map((row) => row.bias_id),
    ).toEqual(["b-1"]);

    db.run("DROP TABLE routing_bias");
    const out = runRoutingBiasListSource({ db, args: {} });
    expect(out.rows).toEqual([]);
    expect(out.warnings[0]).toContain("routing_bias_list:");
  } finally {
    db.close();
  }
});
