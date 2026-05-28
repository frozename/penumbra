import { test, expect, afterEach } from "bun:test";
import { startInProcessDaemon, type InProcessDaemonHarness } from "../helpers/in-process-daemon.js";

let harness;

afterEach(async () => {
  if (harness) await harness.stop();
});

function insertHandoff(harness, id, attempts, maxAttempts, workerId, workflowRunId = null) {
  const stmt = harness.services.db.prepare(`
    INSERT INTO handoffs (
      handoff_id, status, worker_id, dispatch_attempts, max_dispatch_attempts, workflow_run_id, 
      chain_task_type, ts, conversation_id, from_agent, to_agent, message
    )
    VALUES (?, 'dispatched', ?, ?, ?, ?, 'STANDARD', '2026-05-20T00:00:00Z', 'conv-1', 'from', 'to', 'hi')
  `);
  stmt.run(id, workerId, attempts, maxAttempts, workflowRunId);
}

test("Orphan recovery requeues workers under max attempts", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-1", 1, 3, "dead-worker-A", "wf-xyz");
  insertHandoff(harness, "h-2", 1, 3, "dead-worker-A", "wf-xyz");

  harness.markWorkerStale("dead-worker-A");

  const { requeued, exhausted } = harness.triggerOrphanRecovery();
  expect(requeued).toBe(2);
  expect(exhausted).toBe(0);

  const row1 = harness.services.db
    .query(
      "SELECT status, worker_id, dispatch_attempts, workflow_run_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-1");
  expect(row1.status).toBe("approved");
  expect(row1.worker_id).toBeNull();
  expect(row1.dispatch_attempts).toBe(1);
  expect(row1.workflow_run_id).toBe("wf-xyz");

  const row2 = harness.services.db
    .query(
      "SELECT status, worker_id, dispatch_attempts, workflow_run_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-2");
  expect(row2.status).toBe("approved");
  expect(row2.worker_id).toBeNull();

  const events1 = harness.services.db
    .query("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("h-1");
  const lastEvent1 = events1[events1.length - 1];
  expect(lastEvent1.kind).toBe("worker.recovery.requeued");
  expect(JSON.parse(lastEvent1.meta_json)).toMatchObject({
    attempt: 1,
    max_attempts: 3,
    from_worker_id: "dead-worker-A",
    handoff_id: "h-1",
  });
});

test("Orphan recovery fails workers at max attempts", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-3", 3, 3, "dead-worker-B", "wf-abc");

  harness.markWorkerStale("dead-worker-B");

  const { requeued, exhausted } = harness.triggerOrphanRecovery();
  expect(requeued).toBe(0);
  expect(exhausted).toBe(1);

  const row3 = harness.services.db
    .query(
      "SELECT status, worker_id, dispatch_attempts, resolution_reason FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-3");
  expect(row3.status).toBe("failed");
  expect(row3.worker_id).toBeNull();
  expect(row3.resolution_reason).toContain("failed_worker_restart");
  expect(row3.resolution_reason).toContain("attempts exhausted");

  const events = harness.services.db
    .query("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("h-3");
  const lastEvent = events[events.length - 1];
  expect(lastEvent.kind).toBe("worker.recovery.exhausted");
  expect(JSON.parse(lastEvent.meta_json)).toMatchObject({
    attempt: 3,
    max_attempts: 3,
  });
});

test("Orphan recovery cap ensures no infinite loops", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-4", 2, 3, "dead-worker-C");

  harness.markWorkerStale("dead-worker-C");

  let rec = harness.triggerOrphanRecovery();
  expect(rec.requeued).toBe(1);
  expect(rec.exhausted).toBe(0);

  const claimStmt = harness.services.db.prepare(`
    UPDATE handoffs SET status = 'dispatched', worker_id = 'dead-worker-D', dispatch_attempts = 3
    WHERE handoff_id = 'h-4' AND status = 'approved'
  `);
  expect(claimStmt.run().changes).toBe(1);

  harness.markWorkerStale("dead-worker-D");

  rec = harness.triggerOrphanRecovery();
  expect(rec.requeued).toBe(0);
  expect(rec.exhausted).toBe(1);

  const finalRow = harness.services.db
    .query("SELECT status, resolution_reason FROM handoffs WHERE handoff_id = ?")
    .get("h-4");
  expect(finalRow.status).toBe("failed");
});
