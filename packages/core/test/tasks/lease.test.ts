import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import {
  TaskWriter,
  TaskNotFound,
  InvalidTaskStatus,
  LeaseConflict,
} from "../../src/tasks/writer.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "do the thing",
    created_by_kind: "human",
    created_by_id: "cli",
    ...overrides,
  };
}

describe("TaskWriter.lease", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("happy path: lease flips status, writes lease row, emits event", () => {
    const { task_id } = writer.file(baseInput());
    const before = Date.now();
    const { lease_id, expires_at } = writer.lease({ task_id, agent_id: "agent-a" });
    const after = Date.now();

    expect(lease_id).toMatch(/^lease_[0-9a-f-]{36}$/);

    const task = writer.get(task_id);
    expect(task.status).toBe("leased");
    expect(task.updated_at).toBeGreaterThanOrEqual(before);
    expect(task.updated_at).toBeLessThanOrEqual(after);

    const leaseRow = db
      .query<
        {
          id: string;
          task_id: string;
          agent_id: string;
          claimed_at: number;
          expires_at: number;
          released_at: number | null;
          release_reason: string | null;
          auction_score: number | null;
        },
        [string]
      >(`SELECT * FROM task_leases WHERE task_id = ?`)
      .all(task_id);

    expect(leaseRow).toHaveLength(1);
    const row = leaseRow[0]!;
    expect(row.id).toBe(lease_id);
    expect(row.agent_id).toBe("agent-a");
    expect(row.released_at).toBeNull();
    expect(row.release_reason).toBeNull();
    expect(row.auction_score).toBeNull();
    // expires_at = claimed_at + ttl_ms (default 90_000) within 1 ms tolerance
    expect(Math.abs(row.expires_at - row.claimed_at - 90_000)).toBeLessThanOrEqual(1);
    expect(expires_at).toBe(row.expires_at);

    const events = db
      .query<
        { kind: string; actor: string | null; payload_json: string | null },
        [string]
      >(`SELECT kind, actor, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC`)
      .all(task_id);
    expect(events.map((e) => e.kind)).toEqual(["filed", "leased"]);
    const leasedEvent = events[1]!;
    expect(leasedEvent.actor).toBe("agent-a");
    expect(JSON.parse(leasedEvent.payload_json!)).toEqual({ lease_id, ttl_ms: 90_000 });
  });

  test("custom ttl_ms is honored", () => {
    const { task_id } = writer.file(baseInput());
    writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 30_000 });

    const row = db
      .query<
        { claimed_at: number; expires_at: number },
        [string]
      >(`SELECT claimed_at, expires_at FROM task_leases WHERE task_id = ?`)
      .get(task_id);
    expect(row).not.toBeNull();
    expect(row!.expires_at - row!.claimed_at).toBe(30_000);
  });

  test("50 concurrent lease() calls: exactly one fulfilled, 49 LeaseConflict", async () => {
    const { task_id } = writer.file(baseInput());

    const attempts = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => writer.lease({ task_id, agent_id: `agent-${i}` })),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LeaseConflict);
    }

    // DB invariant: at most one open lease for the task
    const openLeases = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ? AND released_at IS NULL`)
      .get(task_id);
    expect(openLeases!.n).toBe(1);
  });

  test("lease against non-pending task throws InvalidTaskStatus", () => {
    const { task_id } = writer.file(baseInput());
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [task_id]);

    let caught: unknown;
    try {
      writer.lease({ task_id, agent_id: "agent-a" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTaskStatus);
    expect((caught as InvalidTaskStatus).current_status).toBe("cancelled");
    expect((caught as Error).message).toContain("cancelled");

    // No lease row inserted, no event appended
    const leases = db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ?`)
      .get(task_id);
    expect(leases!.n).toBe(0);
    const leasedEvents = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'leased'`)
      .get(task_id);
    expect(leasedEvents!.n).toBe(0);
  });

  test("lease for unknown task throws TaskNotFound", () => {
    expect(() => writer.lease({ task_id: "task_does-not-exist", agent_id: "agent-a" })).toThrow(
      TaskNotFound,
    );
  });
});
