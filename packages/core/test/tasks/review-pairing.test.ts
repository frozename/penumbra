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

function fetchReviewChildId(db: Database, parentTaskId: string): string | null {
  const row = db
    .query<
      { id: string },
      [string]
    >(`SELECT id FROM tasks WHERE parent_task_id = ? AND kind = 'review' LIMIT 1`)
    .get(parentTaskId);
  return row?.id ?? null;
}

describe("TaskWriter review pairing", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("auto-files review task on done_pending_review with synthesized fields", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "agent-doer" });

    const completion = writer.complete({
      task_id: parentTaskId,
      lease_id: lease.lease_id,
      result_summary: "implemented A and B",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
    });

    expect(completion.status).toBe("done_pending_review");

    const childId = fetchReviewChildId(db, parentTaskId);
    expect(childId).not.toBeNull();

    const child = writer.get(childId!);
    expect(child.kind).toBe("review");
    expect(child.parent_task_id).toBe(parentTaskId);
    expect(child.prompt).toContain("criterion A");
    expect(child.prompt).toContain("implemented A and B");
    expect(child.acceptance_criteria).toBe(
      "Each parent criterion is met or explicitly rejected with reason.",
    );
    expect(child.expected_artifacts).toEqual([{ type: "review_verdict" }]);
    expect(child.eligibility).toEqual({ min_tier: "premium", deny_agents: ["agent-doer"] });
    expect(child.priority).toBe("high");
    expect(child.requires_review).toBe(false);
    expect(child.created_by_kind).toBe("agent");
    expect(child.created_by_id).toBe("system:review-pairing");
    expect(child.origin).toBe("task-board/v1");
  });

  test("appends review_filed event on parent with review task id payload", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "agent-doer" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: lease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();

    const event = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND kind = 'review_filed'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentTaskId);

    expect(event).not.toBeNull();
    expect(event!.payload_json).not.toBeNull();
    expect(JSON.parse(event!.payload_json!)).toEqual({ review_task_id: reviewTaskId });
  });

  test("review_eligibility is honored and deny_agents merges doer with dedupe + sorting", () => {
    const { task_id: parentTaskId } = writer.file(
      baseInput({
        review_eligibility: { min_tier: "oc", deny_agents: ["x"] },
      }),
    );
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "a-doer" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: lease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();
    const reviewTask = writer.get(reviewTaskId!);
    expect(reviewTask.eligibility).toEqual({
      min_tier: "oc",
      deny_agents: ["a-doer", "x"],
    });
  });

  test("default review eligibility is min_tier premium and doer denied", () => {
    const { task_id: parentTaskId } = writer.file(
      baseInput({
        review_eligibility: undefined,
      }),
    );
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "agent-doer" });
    writer.complete({
      task_id: parentTaskId,
      lease_id: lease.lease_id,
      result_summary: "done",
    });

    const reviewTaskId = fetchReviewChildId(db, parentTaskId);
    expect(reviewTaskId).not.toBeNull();
    const reviewTask = writer.get(reviewTaskId!);
    expect(reviewTask.eligibility).toEqual({ min_tier: "premium", deny_agents: ["agent-doer"] });
  });

  test("priority bumps one bucket and never drops below normal", () => {
    const cases: Array<{ parent: FileTaskInput["priority"]; child: FileTaskInput["priority"] }> = [
      { parent: "low", child: "normal" },
      { parent: "normal", child: "high" },
      { parent: "high", child: "urgent" },
      { parent: "urgent", child: "urgent" },
    ];

    for (const [index, c] of cases.entries()) {
      const { task_id: parentTaskId } = writer.file(
        baseInput({
          prompt: `task-${index}`,
          priority: c.parent,
        }),
      );
      const lease = writer.lease({ task_id: parentTaskId, agent_id: `agent-${index}` });
      writer.complete({
        task_id: parentTaskId,
        lease_id: lease.lease_id,
        result_summary: "done",
      });

      const reviewTaskId = fetchReviewChildId(db, parentTaskId);
      expect(reviewTaskId).not.toBeNull();
      const reviewTask = writer.get(reviewTaskId!);
      expect(reviewTask.priority).toBe(c.child);
    }
  });

  test("does not auto-file review task when parent does not require review", () => {
    const { task_id: parentTaskId } = writer.file(
      baseInput({
        requires_review: false,
      }),
    );
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "agent-doer" });
    const result = writer.complete({
      task_id: parentTaskId,
      lease_id: lease.lease_id,
      result_summary: "done",
    });

    expect(result.status).toBe("done");
    expect(fetchReviewChildId(db, parentTaskId)).toBeNull();
  });

  test("review task auto-file is in same transaction as parent completion", () => {
    const { task_id: parentTaskId } = writer.file(baseInput());
    const lease = writer.lease({ task_id: parentTaskId, agent_id: "agent-doer" });

    const original = (writer as unknown as { _fileInTransaction: (input: unknown) => unknown })
      ._fileInTransaction;
    (writer as unknown as { _fileInTransaction: (input: unknown) => unknown })._fileInTransaction =
      () => {
        throw new Error("simulated review file failure");
      };

    expect(() =>
      writer.complete({
        task_id: parentTaskId,
        lease_id: lease.lease_id,
        result_summary: "done",
      }),
    ).toThrow("simulated review file failure");

    (writer as unknown as { _fileInTransaction: (input: unknown) => unknown })._fileInTransaction =
      original;

    const parentRow = writer.get(parentTaskId);
    expect(parentRow.status).toBe("leased");
    expect(parentRow.result_summary).toBeNull();

    const leaseRow = db
      .query<{ released_at: number | null; release_reason: string | null }, [string]>(
        `SELECT released_at, release_reason
         FROM task_leases
         WHERE id = ?`,
      )
      .get(lease.lease_id);
    expect(leaseRow).not.toBeNull();
    expect(leaseRow!.released_at).toBeNull();
    expect(leaseRow!.release_reason).toBeNull();
  });
});
