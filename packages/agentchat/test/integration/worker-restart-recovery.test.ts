import { afterEach, expect, test } from "bun:test";

import { type InProcessDaemonHarness, startInProcessDaemon } from "../helpers/in-process-daemon.js";

let harness: InProcessDaemonHarness | undefined;

afterEach(async () => {
  if (harness) await harness.stop();
});

type DispatchEventRow = { kind: string; meta_json: string };

function expectRecoveryRequeueThenReoffer(
  events: DispatchEventRow[],
  expected: { attempt: number; from_worker_id: string; handoff_id: string; max_attempts: number },
): void {
  const requeuedIndex = events.findIndex((event) => event.kind === "worker.recovery.requeued");
  expect(requeuedIndex).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(events[requeuedIndex]!.meta_json)).toEqual(expected);

  const reoffer = events.slice(requeuedIndex + 1).find((event) => event.kind === "claim.reoffer");
  expect(reoffer).toBeDefined();
  expect(JSON.parse(reoffer!.meta_json)).toEqual({
    attempt: expected.attempt,
    cause: "orphan_requeue",
    from_worker_id: expected.from_worker_id,
    max_attempts: expected.max_attempts,
  });
}

function insertHandoff(
  harness: InProcessDaemonHarness,
  id: string,
  attempts: number,
  maxAttempts: number,
  workerId: string,
  workflowRunId: string | null = null,
): void {
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
    .query<
      {
        status: string;
        worker_id: string | null;
        dispatch_attempts: number;
        workflow_run_id: string | null;
      },
      [string]
    >(
      "SELECT status, worker_id, dispatch_attempts, workflow_run_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-1");
  expect(row1?.status).toBe("approved");
  expect(row1?.worker_id).toBeNull();
  expect(row1?.dispatch_attempts).toBe(1);
  expect(row1?.workflow_run_id).toBe("wf-xyz");

  const row2 = harness.services.db
    .query<
      {
        status: string;
        worker_id: string | null;
        dispatch_attempts: number;
        workflow_run_id: string | null;
      },
      [string]
    >(
      "SELECT status, worker_id, dispatch_attempts, workflow_run_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-2");
  expect(row2?.status).toBe("approved");
  expect(row2?.worker_id).toBeNull();

  const events1 = harness.services.db
    .query<
      DispatchEventRow,
      [string]
    >("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("h-1");
  expectRecoveryRequeueThenReoffer(events1, {
    attempt: 1,
    from_worker_id: "dead-worker-A",
    handoff_id: "h-1",
    max_attempts: 3,
  });
});

test("Orphan recovery requeues workers after dispatch.start when the worker is stale", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-started", 1, 3, "dead-worker-started", "wf-started");
  harness.services.dispatchEventLog.record({
    handoff_id: "h-started",
    source: "worker",
    kind: "dispatch.start",
    ts: "2026-05-20T00:00:01.000Z",
    meta: { worker_id: "dead-worker-started" },
  });

  harness.markWorkerStale("dead-worker-started");

  const { requeued, exhausted } = harness.triggerOrphanRecovery();
  expect(requeued).toBe(1);
  expect(exhausted).toBe(0);

  const row = harness.services.db
    .query<
      { status: string; worker_id: string | null; dispatch_attempts: number },
      [string]
    >("SELECT status, worker_id, dispatch_attempts FROM handoffs WHERE handoff_id = ?")
    .get("h-started");
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
  expect(row?.dispatch_attempts).toBe(1);

  const events = harness.services.db
    .query<
      DispatchEventRow,
      [string]
    >("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("h-started");
  expectRecoveryRequeueThenReoffer(events, {
    attempt: 1,
    from_worker_id: "dead-worker-started",
    handoff_id: "h-started",
    max_attempts: 3,
  });
});

test("Orphan recovery skips post-start handoffs when the worker is only briefly stale", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-brief-pause", 1, 3, "paused-worker", "wf-brief");
  harness.services.dispatchEventLog.record({
    handoff_id: "h-brief-pause",
    source: "worker",
    kind: "dispatch.start",
    ts: "2026-05-20T00:00:01.000Z",
    meta: { worker_id: "paused-worker" },
  });

  // Stale at the base threshold but NOT at the deep post-start threshold —
  // the transient-pause case that must not double-dispatch.
  const watchdog = harness.services.watchdog as unknown as {
    getStaleWorkers(ms: number): string[];
  };
  const original = watchdog.getStaleWorkers.bind(watchdog);
  watchdog.getStaleWorkers = (ms: number): string[] => (ms <= 1 ? ["paused-worker"] : []);
  try {
    const rec = harness.triggerOrphanRecovery();
    expect(rec.requeued).toBe(0);
    expect(rec.exhausted).toBe(0);

    const row = harness.services.db
      .query<
        { status: string; worker_id: string | null },
        [string]
      >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
      .get("h-brief-pause");
    expect(row?.status).toBe("dispatched");
    expect(row?.worker_id).toBe("paused-worker");
  } finally {
    watchdog.getStaleWorkers = original;
  }
});

test("Orphan recovery fails workers at max attempts", async () => {
  harness = await startInProcessDaemon();

  insertHandoff(harness, "h-3", 3, 3, "dead-worker-B", "wf-abc");

  harness.markWorkerStale("dead-worker-B");

  const { requeued, exhausted } = harness.triggerOrphanRecovery();
  expect(requeued).toBe(0);
  expect(exhausted).toBe(1);

  const row3 = harness.services.db
    .query<
      {
        status: string;
        worker_id: string | null;
        dispatch_attempts: number;
        resolution_reason: string | null;
      },
      [string]
    >(
      "SELECT status, worker_id, dispatch_attempts, resolution_reason FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-3");
  expect(row3?.status).toBe("failed");
  expect(row3?.worker_id).toBeNull();
  expect(row3?.resolution_reason).toContain("failed_worker_restart");
  expect(row3?.resolution_reason).toContain("attempts exhausted");

  const events = harness.services.db
    .query<
      { kind: string; meta_json: string },
      [string]
    >("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("h-3");
  const lastEvent = events[events.length - 1]!;
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
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >("SELECT status, resolution_reason FROM handoffs WHERE handoff_id = ?")
    .get("h-4");
  expect(finalRow?.status).toBe("failed");
});
