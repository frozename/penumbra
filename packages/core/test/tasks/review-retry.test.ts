import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";
import { TaskWriter } from "../../src/tasks/writer.js";

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

function listReviewChildren(
  db: Database,
  parentTaskId: string,
): Array<{ id: string; eligibility: string }> {
  return db
    .query<{ id: string; eligibility: string }, [string]>(
      `SELECT id, eligibility
       FROM tasks
       WHERE parent_task_id = ? AND kind = 'review'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(parentTaskId);
}

function getReviewById(
  db: Database,
  reviewTaskId: string,
): { id: string; eligibility: string; status: string } {
  const row = db
    .query<{ id: string; eligibility: string; status: string }, [string]>(
      `SELECT id, eligibility, status
       FROM tasks
       WHERE id = ?`,
    )
    .get(reviewTaskId);
  if (!row) throw new Error(`missing review task ${reviewTaskId}`);
  return row;
}

function getPendingReviewId(db: Database, parentTaskId: string): string {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id
       FROM tasks
       WHERE parent_task_id = ? AND kind = 'review' AND status = 'pending'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(parentTaskId);
  if (!row) throw new Error(`missing pending review for parent ${parentTaskId}`);
  return row.id;
}

function lastParentEvent(
  db: Database,
  parentTaskId: string,
  kind: string,
): { payload_json: string | null } | null {
  const row = db
    .query<{ payload_json: string | null }, [string, string]>(
      `SELECT payload_json
       FROM task_events
       WHERE task_id = ? AND kind = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(parentTaskId, kind);
  return row ?? null;
}

function setupParentInPendingReview(
  writer: TaskWriter,
  db: Database,
): {
  parent_id: string;
  doer_agent_id: string;
  first_review_id: string;
} {
  const doer_agent_id = "doer-a";
  const { task_id: parent_id } = writer.file(
    baseInput({
      review_eligibility: {
        min_tier: "premium",
        deny_agents: ["seed-deny"],
      },
    }),
  );
  const lease = writer.lease({ task_id: parent_id, agent_id: doer_agent_id });
  writer.complete({
    task_id: parent_id,
    lease_id: lease.lease_id,
    result_summary: "implemented",
    result_artifacts: [{ type: "commit", ref: "abc123" }],
  });

  const first = listReviewChildren(db, parent_id);
  if (first.length !== 1) throw new Error("expected exactly one review child after completion");

  return {
    parent_id,
    doer_agent_id,
    first_review_id: first[0]!.id,
  };
}

describe("TaskWriter review retry on fail", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("R1 fails -> R2 created with doer + R1 denied, parent unchanged", () => {
    const { parent_id, doer_agent_id, first_review_id } = setupParentInPendingReview(writer, db);

    const reviewLease1 = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    writer.fail({
      task_id: first_review_id,
      lease_id: reviewLease1.lease_id,
      reason: "unclear",
    });

    const reviews = listReviewChildren(db, parent_id);
    expect(reviews).toHaveLength(2);

    const reviewFiled = lastParentEvent(db, parent_id, "review_filed");
    expect(reviewFiled).not.toBeNull();
    expect(reviewFiled!.payload_json).not.toBeNull();
    const payload = JSON.parse(reviewFiled!.payload_json!) as { review_task_id: string };
    const secondReview = getReviewById(db, payload.review_task_id);
    const secondEligibility = JSON.parse(secondReview.eligibility) as { deny_agents?: string[] };
    expect(secondEligibility.deny_agents).toEqual([doer_agent_id, "reviewer-r1", "seed-deny"]);

    expect(writer.get(parent_id).status).toBe("done_pending_review");
    expect(payload.review_task_id).not.toBe(first_review_id);
  });

  test("R1 and R2 fail -> R3 created with doer + R1 + R2 denied", () => {
    const { parent_id, doer_agent_id, first_review_id } = setupParentInPendingReview(writer, db);

    const r1Lease = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    writer.fail({ task_id: first_review_id, lease_id: r1Lease.lease_id, reason: "unclear" });

    const secondReviewId = getPendingReviewId(db, parent_id);

    const r2Lease = writer.lease({ task_id: secondReviewId, agent_id: "reviewer-r2" });
    writer.fail({ task_id: secondReviewId, lease_id: r2Lease.lease_id, reason: "still unclear" });

    const afterR2 = listReviewChildren(db, parent_id);
    expect(afterR2).toHaveLength(3);

    const thirdReviewId = getPendingReviewId(db, parent_id);
    const thirdReview = getReviewById(db, thirdReviewId);
    const thirdEligibility = JSON.parse(thirdReview.eligibility) as { deny_agents?: string[] };
    expect(thirdEligibility.deny_agents).toEqual([
      doer_agent_id,
      "reviewer-r1",
      "reviewer-r2",
      "seed-deny",
    ]);

    expect(writer.get(parent_id).status).toBe("done_pending_review");
  });

  test("R1, R2, R3 all fail -> no R4, parent parked with review_failed payload", () => {
    const { parent_id, first_review_id } = setupParentInPendingReview(writer, db);

    const r1Lease = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    writer.fail({ task_id: first_review_id, lease_id: r1Lease.lease_id, reason: "attempt-1" });

    const r2Id = getPendingReviewId(db, parent_id);

    const r2Lease = writer.lease({ task_id: r2Id, agent_id: "reviewer-r2" });
    writer.fail({ task_id: r2Id, lease_id: r2Lease.lease_id, reason: "attempt-2" });

    const r3Id = getPendingReviewId(db, parent_id);

    const r3Lease = writer.lease({ task_id: r3Id, agent_id: "reviewer-r3" });
    writer.fail({ task_id: r3Id, lease_id: r3Lease.lease_id, reason: "attempt-3" });

    const finalChildren = listReviewChildren(db, parent_id);
    expect(finalChildren).toHaveLength(3);
    expect(writer.get(parent_id).status).toBe("done_pending_review");

    const event = lastParentEvent(db, parent_id, "review_failed");
    expect(event).not.toBeNull();
    expect(event!.payload_json).not.toBeNull();
    expect(JSON.parse(event!.payload_json!)).toEqual({
      retries_exhausted: true,
      last_reviewer: "reviewer-r3",
      last_notes: "attempt-3",
    });
  });

  test("lease expiry path does not consume retry or create sibling review-task", () => {
    const { parent_id, first_review_id } = setupParentInPendingReview(writer, db);

    const lease = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    db.run(
      `UPDATE task_leases
       SET released_at = ?, release_reason = 'expired'
       WHERE id = ?`,
      [Date.now(), lease.lease_id],
    );
    db.run(
      `UPDATE tasks
       SET status = 'pending', updated_at = ?
       WHERE id = ?`,
      [Date.now(), first_review_id],
    );

    const children = listReviewChildren(db, parent_id);
    expect(children).toHaveLength(1);
    expect(writer.get(first_review_id).status).toBe("pending");
  });

  test("failing review-task when parent is no longer done_pending_review does not spawn retry", () => {
    const { parent_id, first_review_id } = setupParentInPendingReview(writer, db);
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [parent_id]);

    const lease = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    writer.fail({
      task_id: first_review_id,
      lease_id: lease.lease_id,
      reason: "cannot validate now",
    });

    const children = listReviewChildren(db, parent_id);
    expect(children).toHaveLength(1);
    expect(writer.get(first_review_id).status).toBe("failed");
    expect(writer.get(parent_id).status).toBe("cancelled");
  });
});
