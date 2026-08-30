import { loadSqliteVec, migrate, TaskCooldowns, TaskWriter } from "@penumbra/core";
import { createTaskLeaseSweeper } from "@src/sweepers/task-leases.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  void 0;
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeWriter(db: Database, now: () => number): TaskWriter {
  return new TaskWriter(db, { now });
}

test("expiry path: expired lease is released and task returns to pending", () => {
  const db = setupDb();
  let nowMs = 0;
  const writer = makeWriter(db, () => nowMs);
  const cooldowns = new TaskCooldowns();
  const sweeper = createTaskLeaseSweeper({
    db,
    now: () => nowMs,
    cooldowns,
  });

  const { task_id } = writer.file({
    prompt: "do the thing",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 1_000 });

  nowMs = 1_100;
  sweeper.tick();

  const task = db
    .query<{ status: string }, [string]>(`SELECT status FROM tasks WHERE id = ?`)
    .get(task_id);
  expect(task?.status).toBe("pending");

  const lease = db
    .query<
      { release_reason: string | null },
      [string]
    >(`SELECT release_reason FROM task_leases WHERE task_id = ? ORDER BY claimed_at DESC LIMIT 1`)
    .get(task_id);
  expect(lease?.release_reason).toBe("expired");

  const released = db
    .query<{ kind: string; payload_json: string | null }, [string]>(
      `SELECT kind, payload_json
       FROM task_events
       WHERE task_id = ? AND kind = 'released'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(task_id);
  expect(released?.kind).toBe("released");
  const releasedPayload = JSON.parse(released?.payload_json ?? "{}") as { reason: string };
  expect(releasedPayload.reason).toBe("expired");
});

test("cooldown population and prune", () => {
  const db = setupDb();
  let nowMs = 0;
  const writer = makeWriter(db, () => nowMs);
  const cooldowns = new TaskCooldowns();
  const sweeper = createTaskLeaseSweeper({
    db,
    now: () => nowMs,
    cooldowns,
  });

  const { task_id } = writer.file({
    prompt: "do the thing",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 1_000 });

  nowMs = 1_100;
  sweeper.tick();

  const byAgent = cooldowns.get().get(task_id);
  expect(byAgent?.get("agent-a")).toBe(nowMs + 600_000);

  cooldowns.prune(nowMs + 600_001);
  expect(cooldowns.get().get(task_id)).toBeUndefined();
});

test("idempotent tick: no expirations means no DB changes", () => {
  const db = setupDb();
  let nowMs = 0;
  const writer = makeWriter(db, () => nowMs);
  const cooldowns = new TaskCooldowns();
  const sweeper = createTaskLeaseSweeper({
    db,
    now: () => nowMs,
    cooldowns,
  });

  const { task_id } = writer.file({
    prompt: "still leased",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 5_000 });

  nowMs = 1_000;
  sweeper.tick();
  sweeper.tick();

  const lease = db
    .query<
      { released_at: number | null },
      [string]
    >(`SELECT released_at FROM task_leases WHERE task_id = ?`)
    .get(task_id);
  expect(lease?.released_at).toBeNull();

  const releasedEvents = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'released'`)
    .get(task_id);
  expect(releasedEvents?.n).toBe(0);
});

test("already-released lease is ignored even when expires_at is in the past", () => {
  const db = setupDb();
  let nowMs = 0;
  const writer = makeWriter(db, () => nowMs);
  const cooldowns = new TaskCooldowns();
  const sweeper = createTaskLeaseSweeper({
    db,
    now: () => nowMs,
    cooldowns,
  });

  const { task_id } = writer.file({
    prompt: "already failed",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  const lease = writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 1_000 });
  writer.fail({ task_id, lease_id: lease.lease_id, reason: "failed before expiry" });

  nowMs = 10_000;
  sweeper.tick();

  const leaseRow = db
    .query<
      { release_reason: string | null },
      [string]
    >(`SELECT release_reason FROM task_leases WHERE id = ?`)
    .get(lease.lease_id);
  expect(leaseRow?.release_reason).toBe("failed");

  const releasedEvents = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
       FROM task_events
       WHERE task_id = ? AND kind = 'released'`,
    )
    .get(task_id);
  expect(releasedEvents?.n).toBe(0);
});
