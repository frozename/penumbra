import { loadSqliteVec, migrate } from "@src/index.js";
import { PermissionReader } from "@src/readers/permission.js";
import { PermissionWriter } from "@src/writers/permission.js";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function setup(): { db: Database; w: PermissionWriter; r: PermissionReader } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const w = new PermissionWriter({ db });
  const r = new PermissionReader({ db });
  return { db, w, r };
}

describe("PermissionReader.listByStatus", () => {
  test("filters by single status", () => {
    const { w, r } = setup();
    const baseTs = new Date("2026-04-28T12:00:00.000Z");
    w.create({
      permission_id: "p-1",
      parent_handoff_id: "h-1",
      conversation_id: "c-1",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.create({
      permission_id: "p-2",
      parent_handoff_id: "h-1",
      conversation_id: "c-1",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.decide("p-2", {
      decision: "approve",
      decided_by: "m",
      decided_at: "2026-04-28T12:01:00.000Z",
      reason: null,
    });
    expect(r.listByStatus({ statuses: ["pending"] }).map((p) => p.permission_id)).toEqual(["p-1"]);
    expect(r.listByStatus({ statuses: ["approved"] }).map((p) => p.permission_id)).toEqual(["p-2"]);
  });

  test("filters by multiple statuses", () => {
    const { w, r } = setup();
    const baseTs = new Date("2026-04-28T12:00:00.000Z");
    w.create({
      permission_id: "p-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.create({
      permission_id: "p-2",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.create({
      permission_id: "p-3",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.decide("p-2", {
      decision: "approve",
      decided_by: "m",
      decided_at: "2026-04-28T12:01:00.000Z",
      reason: null,
    });
    w.decide("p-3", {
      decision: "reject",
      decided_by: "m",
      decided_at: "2026-04-28T12:01:00.000Z",
      reason: null,
    });
    const ids = r
      .listByStatus({ statuses: ["approved", "rejected"] })
      .map((p) => p.permission_id)
      .sort();
    expect(ids).toEqual(["p-2", "p-3"]);
  });

  test("filters by conversation_id", () => {
    const { w, r } = setup();
    const baseTs = new Date("2026-04-28T12:00:00.000Z");
    w.create({
      permission_id: "p-A",
      parent_handoff_id: "h-A",
      conversation_id: "conv-A",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.create({
      permission_id: "p-B",
      parent_handoff_id: "h-B",
      conversation_id: "conv-B",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    expect(
      r
        .listByStatus({ statuses: ["pending"], conversation_id: "conv-A" })
        .map((p) => p.permission_id),
    ).toEqual(["p-A"]);
  });

  test("filters by parent_handoff_id", () => {
    const { w, r } = setup();
    const baseTs = new Date("2026-04-28T12:00:00.000Z");
    w.create({
      permission_id: "p-A",
      parent_handoff_id: "h-A",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    w.create({
      permission_id: "p-B",
      parent_handoff_id: "h-B",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: baseTs,
    });
    expect(
      r
        .listByStatus({ statuses: ["pending"], parent_handoff_id: "h-A" })
        .map((p) => p.permission_id),
    ).toEqual(["p-A"]);
  });

  test("throws on empty statuses array", () => {
    const { r } = setup();
    expect(() => r.listByStatus({ statuses: [] })).toThrow();
  });
});

describe("PermissionReader.get", () => {
  test("returns null for unknown id", () => {
    const { r } = setup();
    expect(r.get("nope")).toBeNull();
  });
});
