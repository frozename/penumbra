import type { AgentDescriptor } from "@src/tasks/eligibility.js";
import type { FileTaskInput } from "@src/tasks/schema.js";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { TaskWriter } from "@src/tasks/writer.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

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

function listReviewChildren(db: Database, parentTaskId: string): { id: string }[] {
  return db
    .query<{ id: string }, [string]>(
      `SELECT id
       FROM tasks
       WHERE parent_task_id = ? AND kind = 'review'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(parentTaskId);
}

function setupParentInPendingReview(
  writer: TaskWriter,
  db: Database,
): {
  parent_id: string;
  first_review_id: string;
} {
  const { task_id: parent_id } = writer.file(
    baseInput({
      requires_review: true,
      review_eligibility: { min_tier: "premium", deny_agents: ["seed-deny"] },
    }),
  );
  const lease = writer.lease({ task_id: parent_id, agent_id: "doer-a" });
  writer.complete({
    task_id: parent_id,
    lease_id: lease.lease_id,
    result_summary: "implemented",
    result_artifacts: [{ type: "commit", ref: "abc123" }],
  });

  const reviews = listReviewChildren(db, parent_id);
  if (reviews.length !== 1) throw new Error("expected review child");
  return { parent_id, first_review_id: reviews[0]!.id };
}

function makeAuctionWriter(db: Database, now: () => number): TaskWriter {
  const agents = new Map<string, AgentDescriptor>([
    ["A", { name: "A", tags: [], tier: "standard", cost_cents_per_run: 10 }],
    ["B", { name: "B", tags: [], tier: "standard", cost_cents_per_run: 10 }],
  ]);
  return new TaskWriter(db, {
    now,
    resolveAgent: (name): AgentDescriptor | undefined => agents.get(name),
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
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 90,
            last_outcome_at: "",
          },
          {
            agent_name: "B",
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 20,
            last_outcome_at: "",
          },
        ],
      },
    }),
  });
}

describe("TaskWriter hardening: malformed JSON rows degrade gracefully", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("hydrateTask does not throw on a corrupt eligibility column", () => {
    const { task_id } = writer.file(baseInput());
    db.query("UPDATE tasks SET eligibility = ? WHERE id = ?").run("{not json", task_id);

    let row!: ReturnType<TaskWriter["get"]>;
    expect(() => {
      row = writer.get(task_id);
    }).not.toThrow();
    expect(row.eligibility).toEqual({});
  });

  test("corrupt artifact/review columns fall back to null instead of throwing", () => {
    const { task_id } = writer.file(baseInput({ expected_artifacts: [{ type: "commit" }] }));
    db.query(
      "UPDATE tasks SET expected_artifacts = ?, review_eligibility = ?, result_artifacts = ? WHERE id = ?",
    ).run("{bad", "{bad", "{bad", task_id);

    const row = writer.get(task_id);
    expect(row.expected_artifacts).toBeNull();
    expect(row.review_eligibility).toBeNull();
    expect(row.result_artifacts).toBeNull();
  });

  test("get(include events) does not throw on a corrupt event payload_json", () => {
    const { task_id } = writer.file(baseInput());
    db.query("UPDATE task_events SET payload_json = ? WHERE task_id = ?").run("{not json", task_id);

    let row!: ReturnType<TaskWriter["get"]>;
    expect(() => {
      row = writer.get(task_id, { include: ["events"] });
    }).not.toThrow();
    expect(row.events?.every((event) => event.payload === null)).toBe(true);
  });

  test("listing pending tasks does not throw when a row has corrupt eligibility", () => {
    const { task_id } = writer.file(baseInput());
    db.query("UPDATE tasks SET eligibility = ? WHERE id = ?").run("{not json", task_id);

    expect(() => writer.list({ status: "pending" })).not.toThrow();
  });

  test("fail retry does not throw when a review eligibility row is corrupt", () => {
    const { parent_id, first_review_id } = setupParentInPendingReview(writer, db);
    const lease = writer.lease({ task_id: first_review_id, agent_id: "reviewer-r1" });
    db.query("UPDATE tasks SET eligibility = ? WHERE id = ?").run("{not json", first_review_id);

    expect(() => {
      writer.fail({ task_id: first_review_id, lease_id: lease.lease_id, reason: "unclear" });
    }).not.toThrow();

    expect(listReviewChildren(db, parent_id)).toHaveLength(2);
    expect(writer.get(first_review_id).status).toBe("failed");
  });

  test("auction window does not throw when an auctioned event payload is corrupt", async () => {
    let now = 0;
    writer = makeAuctionWriter(db, () => now);
    const { task_id } = writer.file(baseInput());

    now = 10_000;
    expect(await writer.next({ agent_id: "B" })).toBeNull();
    db.query(
      "UPDATE task_events SET payload_json = ? WHERE task_id = ? AND kind = 'auctioned'",
    ).run("{not json", task_id);

    const leased = await writer.next({ agent_id: "B" });
    expect(leased?.task_id).toBe(task_id);
  });
});
