import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import type { FileTaskInput } from "@src/tasks/schema.js";
import {
  InvalidTaskStatus,
  LeaseInvalid,
  MissingReviewVerdict,
  TaskNotFound,
  TaskWriter,
  UnexpectedReviewVerdict,
} from "@src/tasks/writer.js";

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

function insertReviewTask(db: Database, parent_task_id: string): string {
  const review_task_id = `task_${crypto.randomUUID().toLowerCase()}`;
  const now = Date.now();
  db.run(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      status, result_summary, result_artifacts, failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, 'review', 'normal', ?, NULL, NULL, ?, NULL, 0, 'pending', NULL, NULL, NULL, NULL, ?)`,
    [
      review_task_id,
      now,
      now,
      "workflow",
      "workflow/task-board",
      parent_task_id,
      "review this task",
      JSON.stringify({}),
      "task-board/v1",
    ],
  );
  db.run(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
     VALUES (?, ?, 'filed', ?, NULL)`,
    [review_task_id, now, "workflow/task-board"],
  );
  return review_task_id;
}

describe("TaskWriter lifecycle", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("heartbeat happy path extends lease preserving ttl and appends heartbeat event", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a", ttl_ms: 60_000 });

    const before = db
      .query<
        { claimed_at: number; expires_at: number },
        [string]
      >(`SELECT claimed_at, expires_at FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(before).not.toBeNull();
    const ttl = before!.expires_at - before!.claimed_at;

    const result = writer.heartbeat({ task_id, lease_id: lease.lease_id });
    expect(result.expires_at).toBeGreaterThanOrEqual(lease.expires_at);

    const after = db
      .query<
        { agent_id: string; expires_at: number; released_at: number | null },
        [string]
      >(`SELECT agent_id, expires_at, released_at FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(after).not.toBeNull();
    expect(after!.released_at).toBeNull();
    expect(after!.expires_at).toBe(result.expires_at);

    const heartbeatEvent = db
      .query<
        { at: number; kind: string; actor: string | null; payload_json: string | null },
        [string]
      >(
        `SELECT at, kind, actor, payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'heartbeat'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(task_id);

    expect(heartbeatEvent).not.toBeNull();
    expect(heartbeatEvent!.actor).toBe("agent-a");
    expect(heartbeatEvent!.payload_json).not.toBeNull();
    expect(JSON.parse(heartbeatEvent!.payload_json!)).toEqual({ expires_at: result.expires_at });
    expect(Math.abs(result.expires_at - heartbeatEvent!.at - ttl)).toBeLessThanOrEqual(1);
  });

  test("heartbeat rejects when lease is already released", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    writer.complete({ task_id, lease_id: lease.lease_id, result_summary: "done" });

    expect(() => writer.heartbeat({ task_id, lease_id: lease.lease_id })).toThrow(LeaseInvalid);
  });

  test("heartbeat rejects wrong lease_id", () => {
    const { task_id } = writer.file(baseInput());
    writer.lease({ task_id, agent_id: "agent-a" });

    expect(() => writer.heartbeat({ task_id, lease_id: "lease_missing" })).toThrow(LeaseInvalid);
  });

  test("heartbeat ttl stays constant across multiple beats — no drift", () => {
    let fakeNow = 1_000_000;
    const db2 = freshDb();
    const writer2 = new TaskWriter(db2, () => fakeNow);

    const { task_id } = writer2.file(baseInput());
    const TTL = 60_000;

    const lease = writer2.lease({ task_id, agent_id: "agent-b", ttl_ms: TTL });
    expect(lease.expires_at).toBe(fakeNow + TTL);

    fakeNow += 15_000;
    const hb1 = writer2.heartbeat({ task_id, lease_id: lease.lease_id });
    expect(hb1.expires_at).toBe(fakeNow + TTL);

    fakeNow += 15_000;
    const hb2 = writer2.heartbeat({ task_id, lease_id: lease.lease_id });
    expect(hb2.expires_at).toBe(fakeNow + TTL);

    fakeNow += 15_000;
    const hb3 = writer2.heartbeat({ task_id, lease_id: lease.lease_id });
    expect(hb3.expires_at).toBe(fakeNow + TTL);
  });

  test("complete on work task without review marks done, releases lease, emits completed event", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });

    const result = writer.complete({
      task_id,
      lease_id: lease.lease_id,
      result_summary: "implemented",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
      chain_id: "chain-1",
    });

    expect(result.status).toBe("done");

    const task = writer.get(task_id);
    expect(task.status).toBe("done");
    expect(task.result_summary).toBe("implemented");
    expect(task.result_artifacts).toEqual([{ type: "commit", ref: "abc123" }]);
    expect(task.chain_id).toBe("chain-1");

    const leaseRow = db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >(`SELECT released_at, release_reason FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(leaseRow).not.toBeNull();
    expect(leaseRow!.released_at).not.toBeNull();
    expect(leaseRow!.release_reason).toBe("completed");

    const completed = db
      .query<{ actor: string | null; payload_json: string | null }, [string]>(
        `SELECT actor, payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'completed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(task_id);
    expect(completed).not.toBeNull();
    expect(completed!.actor).toBe("agent-a");
    expect(JSON.parse(completed!.payload_json!)).toEqual({ result_summary: "implemented" });
  });

  test("complete on work task requiring review marks done_pending_review", () => {
    const { task_id } = writer.file(baseInput({ requires_review: true }));
    const lease = writer.lease({ task_id, agent_id: "agent-a" });

    const result = writer.complete({
      task_id,
      lease_id: lease.lease_id,
      result_summary: "implemented",
    });

    expect(result.status).toBe("done_pending_review");
    expect(writer.get(task_id).status).toBe("done_pending_review");
  });

  test("complete on work task rejects review_verdict and rolls back", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });

    expect(() =>
      writer.complete({
        task_id,
        lease_id: lease.lease_id,
        result_summary: "implemented",
        review_verdict: { passed: true, notes: "ok" },
      }),
    ).toThrow(UnexpectedReviewVerdict);

    const task = writer.get(task_id);
    expect(task.status).toBe("leased");
    expect(task.result_summary).toBeNull();

    const leaseRow = db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >(`SELECT released_at, release_reason FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(leaseRow).not.toBeNull();
    expect(leaseRow!.released_at).toBeNull();
    expect(leaseRow!.release_reason).toBeNull();
  });

  test("complete review task passed=true marks review done and parent done with review_passed event", () => {
    const parent = writer.file(baseInput({ requires_review: true })).task_id;
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });

    const review = insertReviewTask(db, parent);
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-a" });
    const result = writer.complete({
      task_id: review,
      lease_id: reviewLease.lease_id,
      result_summary: "review complete",
      review_verdict: { passed: true, notes: "ok" },
    });

    expect(result.status).toBe("done");
    expect(writer.get(review).status).toBe("done");
    expect(writer.get(parent).status).toBe("done");

    const parentEvent = db
      .query<{ actor: string | null; payload_json: string | null }, [string]>(
        `SELECT actor, payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'review_passed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parent);
    expect(parentEvent).not.toBeNull();
    expect(parentEvent!.actor).toBe("reviewer-a");
    expect(JSON.parse(parentEvent!.payload_json!)).toEqual({ notes: "ok" });
  });

  test("complete review task passed=false marks parent failed and emits review_failed event", () => {
    const parent = writer.file(baseInput({ requires_review: true })).task_id;
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });

    const review = insertReviewTask(db, parent);
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-b" });

    writer.complete({
      task_id: review,
      lease_id: reviewLease.lease_id,
      result_summary: "review complete",
      review_verdict: { passed: false, notes: "criterion 2 missing" },
    });

    const parentRow = writer.get(parent);
    expect(parentRow.status).toBe("failed");
    expect(parentRow.failure_reason).toStartWith("review rejected:");
    expect(parentRow.failure_reason).toContain("criterion 2 missing");

    const parentEvent = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'review_failed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parent);
    expect(parentEvent).not.toBeNull();
    expect(JSON.parse(parentEvent!.payload_json!)).toEqual({ notes: "criterion 2 missing" });
  });

  test("complete review task without review_verdict throws MissingReviewVerdict", () => {
    const parent = writer.file(baseInput({ requires_review: true })).task_id;
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });

    const review = insertReviewTask(db, parent);
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-a" });

    expect(() =>
      writer.complete({
        task_id: review,
        lease_id: reviewLease.lease_id,
        result_summary: "review complete",
      }),
    ).toThrow(MissingReviewVerdict);
  });

  test("fail marks failed, stores reason, releases lease, and emits completed event with success=false", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });

    const result = writer.fail({ task_id, lease_id: lease.lease_id, reason: "build failed" });
    expect(result.status).toBe("failed");

    const task = writer.get(task_id);
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toBe("build failed");

    const leaseRow = db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >(`SELECT released_at, release_reason FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(leaseRow).not.toBeNull();
    expect(leaseRow!.released_at).not.toBeNull();
    expect(leaseRow!.release_reason).toBe("failed");

    const event = db
      .query<{ actor: string | null; payload_json: string | null }, [string]>(
        `SELECT actor, payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'completed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(task_id);
    expect(event).not.toBeNull();
    expect(event!.actor).toBe("agent-a");
    expect(JSON.parse(event!.payload_json!)).toEqual({ success: false, reason: "build failed" });
  });

  test("cancel from pending marks cancelled and writes cancelled event", () => {
    const { task_id } = writer.file(baseInput());

    const result = writer.cancel({ task_id, reason: "no longer needed" });
    expect(result.status).toBe("cancelled");

    const task = writer.get(task_id);
    expect(task.status).toBe("cancelled");
    expect(task.failure_reason).toBe("no longer needed");

    const event = db
      .query<{ actor: string | null; payload_json: string | null }, [string]>(
        `SELECT actor, payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'cancelled'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(task_id);
    expect(event).not.toBeNull();
    expect(event!.actor).toBeNull();
    expect(JSON.parse(event!.payload_json!)).toEqual({ reason: "no longer needed" });
  });

  test("cancel from leased releases lease and marks cancelled", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });

    const result = writer.cancel({ task_id });
    expect(result.status).toBe("cancelled");

    const task = writer.get(task_id);
    expect(task.status).toBe("cancelled");
    expect(task.failure_reason).toBeNull();

    const leaseRow = db
      .query<
        { released_at: number | null; release_reason: string | null },
        [string]
      >(`SELECT released_at, release_reason FROM task_leases WHERE id = ?`)
      .get(lease.lease_id);
    expect(leaseRow).not.toBeNull();
    expect(leaseRow!.released_at).not.toBeNull();
    expect(leaseRow!.release_reason).toBe("cancelled");
  });

  test("cancel on a completed task throws and does not overwrite done", () => {
    const { task_id } = writer.file(baseInput());
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    writer.complete({ task_id, lease_id: lease.lease_id, result_summary: "finished" });

    expect(() => writer.cancel({ task_id })).toThrow(InvalidTaskStatus);
    expect(writer.get(task_id).status).toBe("done");
  });

  test("complete/fail/cancel on unknown task throws TaskNotFound", () => {
    expect(() =>
      writer.complete({
        task_id: "task_missing",
        lease_id: "lease_missing",
        result_summary: "x",
      }),
    ).toThrow(TaskNotFound);
    expect(() =>
      writer.fail({
        task_id: "task_missing",
        lease_id: "lease_missing",
        reason: "x",
      }),
    ).toThrow(TaskNotFound);
    expect(() => writer.cancel({ task_id: "task_missing" })).toThrow(TaskNotFound);
  });
});
