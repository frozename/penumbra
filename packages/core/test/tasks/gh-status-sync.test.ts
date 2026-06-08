import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { enqueueGhStatusSyncOnDb, TaskWriter } from "../../src/tasks/writer.js";
import type { AgentDescriptor } from "../../src/tasks/eligibility.js";

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

describe("TaskWriter centralized gh status-sync enqueue", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  function ops(task_id?: string): { op: string; payload: Record<string, unknown> }[] {
    return writer
      .listPendingGhOutbox(500)
      .filter((r) => task_id === undefined || r.task_id === task_id)
      .map((r) => ({ op: r.op, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
  }

  function linkedTask(issue = 7): string {
    const { task_id } = writer.file({
      prompt: "linked work",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: issue });
    db.run(`DELETE FROM gh_outbox`); // ignore any enqueue from linking itself
    return task_id;
  }

  test("lease on a gh-linked task enqueues gh_push_status + pending→leased comment", () => {
    const task_id = linkedTask();
    writer.lease({ task_id, agent_id: "agent-a" });
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "pending", to_status: "leased" });
  });

  test("transitions on a NON-linked task enqueue nothing", () => {
    const { task_id } = writer.file({
      prompt: "unlinked",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    writer.complete({ task_id, lease_id: lease.lease_id, result_summary: "done" });
    expect(ops()).toEqual([]);
  });

  test("complete on a gh-linked work task enqueues a push + leased→done comment", () => {
    const task_id = linkedTask();
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    db.run(`DELETE FROM gh_outbox`); // isolate the complete transition
    writer.complete({ task_id, lease_id: lease.lease_id, result_summary: "done" });
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "leased", to_status: "done" });
  });

  test("fail on a gh-linked task enqueues a push + leased→failed comment", () => {
    const task_id = linkedTask();
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    db.run(`DELETE FROM gh_outbox`);
    writer.fail({ task_id, lease_id: lease.lease_id, reason: "boom" });
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "leased", to_status: "failed" });
  });

  test("cancel on a gh-linked pending task enqueues a push + pending→cancelled comment", () => {
    const task_id = linkedTask();
    writer.cancel({ task_id, reason: "drop" });
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "pending", to_status: "cancelled" });
  });

  test("review-pass flips the gh-linked PARENT to done and enqueues a parent push", () => {
    const parent = writer.file({
      prompt: "parent work",
      created_by_kind: "human",
      created_by_id: "cli",
      requires_review: true,
    }).task_id;
    writer.linkGhIssue(parent, { repo: "acordeiro/penumbra", issue_number: 9 });
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });
    db.run(`DELETE FROM gh_outbox`); // isolate the review-pass flip

    const review = insertReviewTask(db, parent);
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-a" });
    writer.complete({
      task_id: review,
      lease_id: reviewLease.lease_id,
      result_summary: "ok",
      review_verdict: { passed: true, notes: "lgtm" },
    });

    expect(writer.get(parent).status).toBe("done");
    const parentOps = ops(parent);
    expect(parentOps.map((o) => o.op)).toContain("gh_push_status");
    const comment = parentOps.find((o) => o.op === "gh_post_status_comment");
    expect(comment?.payload).toEqual({ from_status: "done_pending_review", to_status: "done" });
  });

  test("complete on a gh-linked work task requiring review enqueues leased→done_pending_review", () => {
    const { task_id } = writer.file({
      prompt: "needs review",
      created_by_kind: "human",
      created_by_id: "cli",
      requires_review: true,
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 21 });
    const lease = writer.lease({ task_id, agent_id: "agent-a" });
    db.run(`DELETE FROM gh_outbox`); // isolate the complete transition
    const res = writer.complete({ task_id, lease_id: lease.lease_id, result_summary: "done" });
    expect(res.status).toBe("done_pending_review");
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "leased", to_status: "done_pending_review" });
  });

  test("review-fail flips the gh-linked PARENT to failed and enqueues a parent push", () => {
    const parent = writer.file({
      prompt: "parent work",
      created_by_kind: "human",
      created_by_id: "cli",
      requires_review: true,
    }).task_id;
    writer.linkGhIssue(parent, { repo: "acordeiro/penumbra", issue_number: 31 });
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });
    db.run(`DELETE FROM gh_outbox`); // isolate the review-fail flip

    const review = insertReviewTask(db, parent);
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-a" });
    writer.complete({
      task_id: review,
      lease_id: reviewLease.lease_id,
      result_summary: "rejected",
      review_verdict: { passed: false, notes: "criterion 2 missing" },
    });

    expect(writer.get(parent).status).toBe("failed");
    const parentOps = ops(parent);
    expect(parentOps.map((o) => o.op)).toContain("gh_push_status");
    const comment = parentOps.find((o) => o.op === "gh_post_status_comment");
    expect(comment?.payload).toEqual({ from_status: "done_pending_review", to_status: "failed" });
  });

  test("cancel on a gh-linked leased task enqueues leased→cancelled", () => {
    const task_id = linkedTask();
    writer.lease({ task_id, agent_id: "agent-a" });
    db.run(`DELETE FROM gh_outbox`); // isolate the cancel transition
    writer.cancel({ task_id, reason: "drop" });
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "leased", to_status: "cancelled" });
  });

  test("completing a gh-linked REVIEW task enqueues the review task's own leased→done", () => {
    const parent = writer.file({
      prompt: "parent",
      created_by_kind: "human",
      created_by_id: "cli",
      requires_review: true,
    }).task_id;
    const parentLease = writer.lease({ task_id: parent, agent_id: "worker-a" });
    writer.complete({ task_id: parent, lease_id: parentLease.lease_id, result_summary: "ready" });

    const review = insertReviewTask(db, parent);
    writer.linkGhIssue(review, { repo: "acordeiro/penumbra", issue_number: 41 });
    const reviewLease = writer.lease({ task_id: review, agent_id: "reviewer-a" });
    db.run(`DELETE FROM gh_outbox`); // isolate the review task's own completion
    writer.complete({
      task_id: review,
      lease_id: reviewLease.lease_id,
      result_summary: "ok",
      review_verdict: { passed: true, notes: "lgtm" },
    });

    const reviewOps = ops(review);
    expect(reviewOps.map((o) => o.op)).toContain("gh_push_status");
    const comment = reviewOps.find((o) => o.op === "gh_post_status_comment");
    expect(comment?.payload).toEqual({ from_status: "leased", to_status: "done" });
  });

  test("next() auction lease on a gh-linked task enqueues pending→leased", async () => {
    let nowMs = 0;
    const agents = new Map<string, AgentDescriptor>([
      ["A", { name: "A", tags: ["core"], tier: "oc", cost_cents_per_run: 25 }],
    ]);
    const auctionWriter = new TaskWriter(db, {
      now: () => nowMs,
      resolveAgent: (name) => agents.get(name),
      routeAgent: () => ({
        detail: "rank" as const,
        candidates: {
          task_type: "implement_substantial",
          window: { from: null, to: "" },
          candidates: [
            {
              agent_name: "A",
              samples: 1,
              successes: 1,
              failures: 0,
              neutral: 0,
              success_rate: 1,
              avg_rounds: null,
              avg_latency_ms: null,
              avg_exec_ms: null,
              cost_per_success_usd: null,
              avg_reviewer_findings: null,
              avg_trust_score: null,
              score: 90,
              last_outcome_at: "",
            },
          ],
        },
      }),
    });
    const { task_id } = auctionWriter.file({
      prompt: "auction lease",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    auctionWriter.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 51 });
    db.run(`DELETE FROM gh_outbox`); // isolate the auction lease transition
    nowMs = 10_000;
    const leased = await auctionWriter.next({ agent_id: "A" });
    expect(leased?.task_id).toBe(task_id);
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "pending", to_status: "leased" });
  });
});

describe("enqueueGhStatusSyncOnDb (raw-SQL bypass paths)", () => {
  let db: Database;
  let writer: TaskWriter;
  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  function ops(task_id: string): { op: string; payload: Record<string, unknown> }[] {
    return writer
      .listPendingGhOutbox(500)
      .filter((r) => r.task_id === task_id)
      .map((r) => ({ op: r.op, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
  }

  function linkedTask(issue = 70): string {
    const { task_id } = writer.file({
      prompt: "x",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: issue });
    db.run(`DELETE FROM gh_outbox`);
    return task_id;
  }

  test("from+to enqueues push + status comment for a gh-linked task (lease-expiry path)", () => {
    const task_id = linkedTask();
    enqueueGhStatusSyncOnDb(db, 1000, task_id, "leased", "pending");
    const got = ops(task_id);
    expect(got.map((o) => o.op)).toEqual(["gh_push_status", "gh_post_status_comment"]);
    expect(got[1]!.payload).toEqual({ from_status: "leased", to_status: "pending" });
  });

  test("from=null enqueues a push only, no comment (raw-SQL fail-without-lease path)", () => {
    const task_id = linkedTask();
    enqueueGhStatusSyncOnDb(db, 1000, task_id, null, "failed");
    expect(ops(task_id).map((o) => o.op)).toEqual(["gh_push_status"]);
  });

  test("a non-gh-linked task is a no-op", () => {
    const { task_id } = writer.file({
      prompt: "x",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    enqueueGhStatusSyncOnDb(db, 1000, task_id, "leased", "pending");
    expect(ops(task_id)).toEqual([]);
  });
});
