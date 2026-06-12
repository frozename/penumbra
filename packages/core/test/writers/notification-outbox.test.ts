import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, NotificationOutboxWriter } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";

function setup(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe("NotificationOutboxWriter", () => {
  let db: Database;
  let outbox: NotificationOutboxWriter;

  beforeEach(() => {
    db = setup();
    outbox = new NotificationOutboxWriter(db);
  });

  it("enqueues entries and retrieves them", () => {
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "ref-1",
      summary: "Fix the login bug",
      created_at: 1000,
    });

    const pending = outbox.listPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("task_draft");
    expect(pending[0].reference_id).toBe("ref-1");
    expect(pending[0].project_id).toBe("test-project");
    expect(pending[0].coalesce_key).toBe("test-project");
    expect(pending[0].status).toBe("pending");
  });

  it("deduplicates by kind + reference_id", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 1000,
    });
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 2000,
    });

    const pending = outbox.listPending(10);
    expect(pending.length).toBe(1);
  });

  it("allows different kinds with same reference_id", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 1000,
    });
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft_escalation",
      reference_id: "ref-1",
      created_at: 2000,
    });

    const pending = outbox.listPending(10);
    expect(pending.length).toBe(2);
  });

  it("claims pending entries for processing once and increments attempt count", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 1000,
    });

    const pending = outbox.listPending(10);
    const id = pending[0].id;

    expect(outbox.markProcessing(id, 2000)).toBe(true);
    expect(outbox.markProcessing(id, 2100)).toBe(false);

    let row = db
      .query("SELECT status, attempted_at, attempt_count FROM notification_outbox WHERE id=?")
      .get(id) as any;
    expect(row.status).toBe("processing");
    expect(row.attempted_at).toBe(2000);
    expect(row.attempt_count).toBe(1);

    outbox.markDone(id, 3000);
    row = db
      .query("SELECT status, completed_at FROM notification_outbox WHERE id=?")
      .get(id) as any;
    expect(row.status).toBe("done");
    expect(row.completed_at).toBe(3000);
  });

  it("reclaims stale processing entries back to pending", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-stale",
      created_at: 1000,
    });

    const id = outbox.listPending(10)[0].id;
    expect(outbox.markProcessing(id, 2000)).toBe(true);

    expect(outbox.requeueStaleProcessing(1500)).toBe(0);
    expect(outbox.requeueStaleProcessing(2500)).toBe(1);

    const row = db
      .query("SELECT status, attempted_at FROM notification_outbox WHERE id=?")
      .get(id) as any;
    expect(row.status).toBe("pending");
    expect(row.attempted_at).toBe(2000);
  });

  it("reschedules retryable failures with deliver_after", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-retry",
      created_at: 1000,
    });

    const id = outbox.listPending(10)[0].id;
    expect(outbox.markProcessing(id, 2000)).toBe(true);
    outbox.markRetry(id, "discord_post_failed", 5100);

    const row = db
      .query(
        "SELECT status, error, deliver_after, completed_at FROM notification_outbox WHERE id=?",
      )
      .get(id) as any;
    expect(row.status).toBe("pending");
    expect(row.error).toBe("discord_post_failed");
    expect(row.deliver_after).toBe(5100);
    expect(row.completed_at).toBeNull();
  });

  it("transitions entries to failed", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 1000,
    });

    const pending = outbox.listPending(10);
    outbox.markFailed(pending[0].id, 2000, "discord_post_failed");

    const row = db
      .query("SELECT status, error FROM notification_outbox WHERE id=?")
      .get(pending[0].id) as any;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("discord_post_failed");
  });

  it("lists pending entries before a cutoff", () => {
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-old",
      created_at: 1000,
    });
    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-new",
      created_at: 600_000,
    });

    const entries = outbox.listPendingBeforeCutoff(300_000, 10);
    expect(entries.length).toBe(1);
    expect(entries[0].reference_id).toBe("ref-old");
  });

  it("checks existence by kind and reference_id", () => {
    expect(outbox.exists("task_draft", "ref-1")).toBe(false);

    outbox.enqueue({
      project_id: "p1",
      kind: "task_draft",
      reference_id: "ref-1",
      created_at: 1000,
    });

    expect(outbox.exists("task_draft", "ref-1")).toBe(true);
    expect(outbox.exists("task_draft_escalation", "ref-1")).toBe(false);
  });

  it("stores null project_id with _default coalesce key", () => {
    outbox.enqueue({
      project_id: null,
      kind: "task_draft",
      reference_id: "ref-null",
      created_at: 1000,
    });

    const pending = outbox.listPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0].project_id).toBeNull();
    expect(pending[0].coalesce_key).toBe("_default");
  });
});
