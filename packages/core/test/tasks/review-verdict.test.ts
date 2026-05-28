import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";
import {
  LeaseInvalid,
  MissingReviewVerdict,
  ReviewParentInvalidState,
  TaskWriter,
  UnexpectedReviewVerdict,
} from "../../src/tasks/writer.js";

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
    prompt: "implement feature X",
    acceptance_criteria: "criterion A\ncriterion B",
    created_by_kind: "human",
    created_by_id: "cli",
    priority: "normal",
    requires_review: true,
    origin: "task-board/v1",
    ...overrides,
  };
}

function fetchReviewChildId(db: Database, parentTaskId: string): string | null {
  const row = db
    .query<
      { id: string },
      [string]
    >(`SELECT id FROM tasks WHERE parent_task_id = ? AND kind = 'review' LIMIT 1`)
    .get(parentTaskId);
  return row?.id ?? null;
}

describe("TaskWriter review verdict transitions parent task", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("passing review verdict closes parent and leaves review task done", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const parentLease = writer.lease({ task_id: parentTaskId, agent_id: "doer-a" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: parentLease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    const reviewLease = writer.lease({ task_id: reviewTaskId!, agent_id: "reviewer-a" });
    const result = writer.complete({
      task_id: reviewTaskId!,
      lease_id: reviewLease.lease_id,
      result_summary: "reviewed",
      review_verdict: { passed: true, notes: "all criteria met" },
    });

    expect(result.status).toBe("done");
    expect(writer.get(parentTaskId).status).toBe("done");
    expect(writer.get(reviewTaskId!).status).toBe("done");

    const parentEvent = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'review_passed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentTaskId);
    expect(parentEvent).not.toBeNull();
    expect(JSON.parse(parentEvent!.payload_json!)).toEqual({ notes: "all criteria met" });

    const reviewCompleted = db
      .query<{ kind: string; actor: string | null }, [string]>(
        `SELECT kind, actor
         FROM task_events
         WHERE task_id = ? AND kind = 'completed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(reviewTaskId!);
    expect(reviewCompleted).not.toBeNull();
    expect(reviewCompleted!.kind).toBe("completed");
    expect(reviewCompleted!.actor).toBe("reviewer-a");
  });

  test("failing review verdict closes parent as failed", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const parentLease = writer.lease({ task_id: parentTaskId, agent_id: "doer-a" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: parentLease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    const reviewLease = writer.lease({ task_id: reviewTaskId!, agent_id: "reviewer-b" });
    const result = writer.complete({
      task_id: reviewTaskId!,
      lease_id: reviewLease.lease_id,
      result_summary: "reviewed",
      review_verdict: { passed: false, notes: "criterion 2 missing" },
    });

    expect(result.status).toBe("done");
    const parent = writer.get(parentTaskId);
    expect(parent.status).toBe("failed");
    expect(parent.failure_reason).toStartWith("review rejected: criterion 2 missing");

    const parentEvent = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'review_failed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentTaskId);
    expect(parentEvent).not.toBeNull();
    expect(JSON.parse(parentEvent!.payload_json!)).toEqual({ notes: "criterion 2 missing" });
  });

  test("missing review verdict on review task throws typed error", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const parentLease = writer.lease({ task_id: parentTaskId, agent_id: "doer-a" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: parentLease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    const reviewLease = writer.lease({ task_id: reviewTaskId!, agent_id: "reviewer-c" });
    expect(() =>
      writer.complete({
        task_id: reviewTaskId!,
        lease_id: reviewLease.lease_id,
        result_summary: "reviewed",
      }),
    ).toThrow(MissingReviewVerdict);
  });

  test("review verdict on work task throws typed error", () => {
    const { task_id } = writer.file(baseInput({ requires_review: false }));
    const lease = writer.lease({ task_id, agent_id: "worker-a" });

    expect(() =>
      writer.complete({
        task_id,
        lease_id: lease.lease_id,
        result_summary: "done",
        review_verdict: { passed: true, notes: "all criteria met" },
      }),
    ).toThrow(UnexpectedReviewVerdict);
  });

  test("review verdict rejects when parent is not pending review", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const parentLease = writer.lease({ task_id: parentTaskId, agent_id: "doer-a" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: parentLease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    db.run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [parentTaskId]);

    const reviewLease = writer.lease({ task_id: reviewTaskId!, agent_id: "reviewer-d" });
    expect(() =>
      writer.complete({
        task_id: reviewTaskId!,
        lease_id: reviewLease.lease_id,
        result_summary: "reviewed",
        review_verdict: { passed: true, notes: "all criteria met" },
      }),
    ).toThrow(ReviewParentInvalidState);
  });

  test("replaying a completed review task fails because the lease is already released", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const parentLease = writer.lease({ task_id: parentTaskId, agent_id: "doer-a" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: parentLease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    const reviewLease = writer.lease({ task_id: reviewTaskId!, agent_id: "reviewer-e" });
    writer.complete({
      task_id: reviewTaskId!,
      lease_id: reviewLease.lease_id,
      result_summary: "reviewed",
      review_verdict: { passed: true, notes: "all criteria met" },
    });

    expect(() =>
      writer.complete({
        task_id: reviewTaskId!,
        lease_id: reviewLease.lease_id,
        result_summary: "reviewed again",
        review_verdict: { passed: true, notes: "all criteria met" },
      }),
    ).toThrow(LeaseInvalid);
  });
});
