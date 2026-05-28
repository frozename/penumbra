import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, loadSqliteVec } from "../../src/index.js";
import { PermissionWriter } from "../../src/writers/permission.js";
import { PermissionReader } from "../../src/readers/permission.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function freshDb() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

describe("PermissionWriter.create", () => {
  test("inserts a pending row with derived ttl_at", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    const r = new PermissionReader({ db });
    const { row } = w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "conv-1",
      agent_name: "claude-acp-sonnet",
      tool_name: "fs.readTextFile",
      raw_input: { path: "src/foo.ts" },
      ttl_seconds: 300,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    expect(row.status).toBe("pending");
    expect(row.ttl_at).toBe("2026-04-28T12:05:00.000Z");
    expect(row.created_at).toBe("2026-04-28T12:00:00.000Z");
    expect(row.raw_input_json).toBe('{"path":"src/foo.ts"}');
    expect(r.get("perm-1")?.status).toBe("pending");
  });

  test("is idempotent on permission_id collision (returns existing row)", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    const first = w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    const second = w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t-different",
      raw_input: { changed: true },
      ttl_seconds: 600,
      now: new Date("2026-04-28T13:00:00.000Z"),
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row).toEqual(first.row);
  });
});

describe("PermissionWriter.decide", () => {
  test("approves a pending row atomically", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    const decided = w.decide("perm-1", {
      decision: "approve",
      remember: "this_dispatch",
      decided_by: "machine-test",
      decided_at: "2026-04-28T12:01:00.000Z",
      reason: null,
    });
    expect(decided?.status).toBe("approved");
    expect(decided?.remember_scope).toBe("this_dispatch");
    expect(decided?.decided_by).toBe("machine-test");
  });

  test("returns null when row is already terminal (no double-decide)", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    w.decide("perm-1", {
      decision: "reject",
      decided_by: "m",
      decided_at: "2026-04-28T12:01:00.000Z",
      reason: null,
    });
    const second = w.decide("perm-1", {
      decision: "approve",
      decided_by: "m",
      decided_at: "2026-04-28T12:02:00.000Z",
      reason: null,
    });
    expect(second).toBeNull();
  });

  test("returns null for unknown permission_id", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    expect(
      w.decide("nope", { decision: "approve", decided_by: "m", decided_at: "t", reason: null }),
    ).toBeNull();
  });
});

describe("PermissionWriter.expirePastDue", () => {
  test("transitions only pending rows past ttl", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: "p-fresh",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 300,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    w.create({
      permission_id: "p-stale",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    const r = new PermissionReader({ db });
    // p-fresh ttl=12:05; p-stale ttl=12:01. Sweep at 12:02 should expire only p-stale.
    const n = w.expirePastDue("2026-04-28T12:02:00.000Z");
    expect(n).toBe(1);
    expect(r.get("p-fresh")?.status).toBe("pending");
    expect(r.get("p-stale")?.status).toBe("expired");
  });

  test("is idempotent against concurrent decide()", () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });
    const decided = w.decide("perm-1", {
      decision: "approve",
      decided_by: "m",
      decided_at: "2026-04-28T12:00:30.000Z",
      reason: null,
    });
    expect(decided?.status).toBe("approved");
    // Sweeper runs after the decide — should NOT flip approved → expired.
    const n = w.expirePastDue("2026-04-28T12:05:00.000Z");
    expect(n).toBe(0);
    const r = new PermissionReader({ db });
    expect(r.get("perm-1")?.status).toBe("approved");
  });
});
