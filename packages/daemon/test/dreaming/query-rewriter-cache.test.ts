import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { applySchema } from "../../../core/src/db/schema.js";
import { loadSqliteVec } from "../../../core/src/db/sqlite-vec.js";
import {
  getRewriteForMemory,
  type RewriteVerdict,
  setRewriteForMemory,
} from "../../src/dreaming/query-rewriter-cache.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;

function seedMemory(db: Database, memoryId: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO t2_memories(
      memory_id, user_id, kind, source_session_ids, window_start, window_end,
      title, body, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    memoryId,
    "u1",
    "note",
    "[]",
    updatedAt,
    updatedAt,
    `title-${memoryId}`,
    `body-${memoryId}`,
    updatedAt,
    updatedAt,
  );
}

describe("dreaming/query-rewriter-cache", () => {
  it("writes and reads a rewrite cache row by t2 memory id", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const nowMs = 1_700_000_000_000;
    const updatedAtMs = 12_345;
    const memoryId = "m1";
    seedMemory(db, memoryId, new Date(updatedAtMs).toISOString());

    const verdict: RewriteVerdict = { kind: "query", query: "rewritten query" };
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: updatedAtMs,
      verdict,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });

    const row = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: updatedAtMs,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    expect(row).not.toBeNull();
    expect(row?.verdict).toEqual(verdict);
    expect(row?.model).toBe("granite-4.1-3b");
    expect(row?.created_at_ms).toBe(nowMs);
    expect(row?.expires_at_ms).toBe(nowMs + 30 * DAY_MS);
    db.close();
  });

  it("invalidates cache when memory updated_at has changed", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryId = "m1";
    seedMemory(db, memoryId, new Date(1000).toISOString());

    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1000,
      verdict: { kind: "query", query: "query" },
      model: "granite-4.1-3b",
      now_ms: 1234,
    });

    const missing = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 2000,
      model: "granite-4.1-3b",
      now_ms: 1234,
    });
    expect(missing).toBeNull();
    db.close();
  });

  it("invalidates cache entries past expiry", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryId = "m1";
    seedMemory(db, memoryId, new Date(1000).toISOString());
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1000,
      verdict: { kind: "query", query: "query" },
      model: "granite-4.1-3b",
      now_ms: 1_000,
      ttl_ms: 3_000,
    });

    const expired = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1000,
      model: "granite-4.1-3b",
      now_ms: 5_001,
    });
    expect(expired).toBeNull();
    db.close();
  });

  it("separates query and skip verdict rows", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const nowMs = 1_000;
    seedMemory(db, "m-query", new Date(1000).toISOString());
    seedMemory(db, "m-skip", new Date(1000).toISOString());

    setRewriteForMemory({
      db,
      t2_memory_id: "m-query",
      memory_updated_at_ms: 1000,
      verdict: { kind: "query", query: "keep search terms" },
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    setRewriteForMemory({
      db,
      t2_memory_id: "m-skip",
      memory_updated_at_ms: 1000,
      verdict: { kind: "skip", reason: "low-utility title" },
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });

    const queryRow = getRewriteForMemory({
      db,
      t2_memory_id: "m-query",
      memory_updated_at_ms: 1000,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    const skipRow = getRewriteForMemory({
      db,
      t2_memory_id: "m-skip",
      memory_updated_at_ms: 1000,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    expect(queryRow?.verdict).toEqual({ kind: "query", query: "keep search terms" });
    expect(skipRow?.verdict).toEqual({ kind: "skip", reason: "low-utility title" });
    db.close();
  });

  it("overwrites previous row for the same memory id and updated_at on write", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryId = "m1";
    seedMemory(db, memoryId, new Date(1234).toISOString());

    const updatedAt = 1234;
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: updatedAt,
      verdict: { kind: "query", query: "first" },
      model: "granite-4.1-3b",
      now_ms: 1_000,
    });
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: updatedAt,
      verdict: { kind: "query", query: "second" },
      model: "granite-4.1-3b",
      now_ms: 2_000,
    });

    const row = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: updatedAt,
      model: "granite-4.1-3b",
      now_ms: 2_000,
    });
    expect(row?.verdict).toEqual({ kind: "query", query: "second" });
    expect(row?.created_at_ms).toBe(2_000);

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM dream_query_rewrites WHERE t2_memory_id = ?`)
      .get(memoryId) as {
      n: number;
    };
    expect(count.n).toBe(1);
    db.close();
  });

  it("uses a 30-day default TTL when ttl_ms is omitted", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryId = "m1";
    const nowMs = 1_000;
    seedMemory(db, memoryId, new Date(1000).toISOString());
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1000,
      verdict: { kind: "query", query: "query" },
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });

    const row = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1000,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    expect(row?.expires_at_ms - row?.created_at_ms).toBe(DEFAULT_TTL_MS);
    db.close();
  });

  it("stores separate rewrite cache rows per model", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const memoryId = "m1";
    const nowMs = 1_700_000_000_000;
    seedMemory(db, memoryId, new Date(1234).toISOString());

    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1234,
      verdict: { kind: "query", query: "granite query" },
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    setRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1234,
      verdict: { kind: "query", query: "qwen query" },
      model: "qwen",
      now_ms: nowMs,
    });

    const graniteRow = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1234,
      model: "granite-4.1-3b",
      now_ms: nowMs,
    });
    const qwenRow = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1234,
      model: "qwen",
      now_ms: nowMs,
    });
    const wrongModel = getRewriteForMemory({
      db,
      t2_memory_id: memoryId,
      memory_updated_at_ms: 1234,
      model: "other-model",
      now_ms: nowMs,
    });

    expect(graniteRow?.verdict).toEqual({ kind: "query", query: "granite query" });
    expect(qwenRow?.verdict).toEqual({ kind: "query", query: "qwen query" });
    expect(wrongModel).toBeNull();
    db.close();
  });
});
