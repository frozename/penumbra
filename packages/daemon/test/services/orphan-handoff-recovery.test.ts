import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { OrphanHandoffRecoveryService } from "../../src/services/orphan-handoff-recovery.js";
import { WatchdogService } from "../../src/services/watchdog.js";
import { handoffsCreateRoute, handoffsApproveRoute } from "../../src/routes/handoffs.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/orphan-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-20T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  return services;
}

async function createDispatchedHandoff(services: Services, workerId: string) {
  const created = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
          max_dispatch_attempts: 3,
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    created.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(created.handoff_id, workerId);
  return created.handoff_id as string;
}

function setLastDispatchStartedAt(services: Services, handoffId: string, ts: string) {
  services.db
    .query("UPDATE handoffs SET last_dispatch_started_at=? WHERE handoff_id=?")
    .run(ts, handoffId);
}

function recordDispatchStart(services: Services, handoffId: string, workerId: string, ts: string) {
  services.dispatchEventLog.record({
    handoff_id: handoffId,
    source: "agent",
    kind: "dispatch.start",
    ts,
    worker_id: workerId,
  });
}

test("OrphanHandoffRecoveryService requeues never-heartbeat workers with deep-stale current dispatch start", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 1000 });

  const workerId = "never-heartbeat-deep-stale";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const deepStale = new Date(Date.now() - 10_000).toISOString();
  setLastDispatchStartedAt(services, handoffId, deepStale);
  recordDispatchStart(services, handoffId, workerId, deepStale);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("OrphanHandoffRecoveryService ignores never-heartbeat workers with recent current dispatch start", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 60_000 });

  const workerId = "never-heartbeat-recent";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const recent = new Date(Date.now()).toISOString();
  setLastDispatchStartedAt(services, handoffId, recent);
  recordDispatchStart(services, handoffId, workerId, recent);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe(workerId);
});

test("OrphanHandoffRecoveryService ignores old dispatch.start events when current dispatch start is recent", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 60_000 });

  const workerId = "redispatched-fresh-worker";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const oldDeadAttempt = new Date(Date.now() - 600_000).toISOString();
  const recent = new Date(Date.now()).toISOString();
  setLastDispatchStartedAt(services, handoffId, recent);
  recordDispatchStart(services, handoffId, "old-dead-worker", oldDeadAttempt);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe(workerId);
});

test("OrphanHandoffRecoveryService requeues when attempts < max", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 }); // 0 ms means everything is stale

  const w1 = "dead-worker-1";

  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
          max_dispatch_attempts: 3,
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1)); // Ensure Date.now() is slightly later

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
  expect(row?.dispatch_attempts).toBe(1);

  const events = services.dispatchEventLog.listByHandoff(c1.handoff_id);
  expect(events.some((e) => e.kind === "worker.recovery.requeued")).toBe(true);
});

test("recoverAll runs at most once for concurrent callers", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();
  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);
  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1));

  const recoverAllInner = vi.spyOn(recovery as any, "recoverAllInner");
  await Promise.all([recovery.recoverAll(), recovery.recoverAll(), recovery.recoverAll()]);

  expect(recoverAllInner).toHaveBeenCalledTimes(1);
});

test("OrphanHandoffRecoveryService fails when attempts == max", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";

  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();
  services.db
    .query("UPDATE handoffs SET max_dispatch_attempts=1 WHERE handoff_id=?")
    .run(c1.handoff_id);

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1));

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 1 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("failed");
  expect(row?.resolution_reason).toContain("failed_worker_restart");

  const events = services.dispatchEventLog.listByHandoff(c1.handoff_id);
  expect(events.some((e) => e.kind === "worker.recovery.exhausted")).toBe(true);
});

test("OrphanHandoffRecoveryService CAS race avoids double action", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1));

  const orphans = services.handoffReader.listOrphanedDispatches([w1]);
  services.handoffWriter.requeueOrphanedDispatch(c1.handoff_id, w1);

  let requeued = 0;
  for (const orphan of orphans) {
    if (!orphan.worker_id) continue;
    const won = services.handoffWriter.requeueOrphanedDispatch(orphan.handoff_id, orphan.worker_id);
    if (won) requeued++;
  }
  expect(requeued).toBe(0); // already requeued above
});

test("OrphanHandoffRecoveryService ignores fresh workers", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 90000 });

  const w1 = "fresh-worker-1";
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 0 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("dispatched"); // untouched
});

test("OrphanHandoffRecoveryService runOnce(workerId) only touches specified worker orphans", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-A";
  const w2 = "dead-worker-B";

  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m1",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    )
  ).json();
  const c2 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m2",
          conversation_id: "c2",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c2.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c2.handoff_id, w2);

  services.watchdog.recordHeartbeat(w1);
  services.watchdog.recordHeartbeat(w2);
  await new Promise((r) => setTimeout(r, 1));

  const result = recovery.runOnce(w1);
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row1 = services.handoffReader.get(c1.handoff_id);
  expect(row1?.status).toBe("approved"); // requeued

  const row2 = services.handoffReader.get(c2.handoff_id);
  expect(row2?.status).toBe("dispatched"); // untouched, still dispatched to w2
});

test("OrphanHandoffRecoveryService runOnce(workerId) bypasses watchdog stale check", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 90000 }); // very long stale ms

  const w1 = "dead-worker-A";

  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1); // fresh

  const result = recovery.runOnce(w1);
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 }); // should requeue despite being fresh in watchdog

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("approved"); // requeued
});

test("OrphanHandoffRecoveryService caps stale workers per call", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  // Mock watchdog to return 100 stale workers
  const manyWorkers = Array.from({ length: 100 }, (_, i) => "worker-" + i);
  (services.watchdog as any).getStaleWorkers = () => manyWorkers;

  // Mock handoffReader to track calls
  let listOrphanedCalls = 0;
  let capturedStaleWorkerIds: string[] = [];
  services.handoffReader.listOrphanedDispatches = (ids, limit) => {
    listOrphanedCalls++;
    capturedStaleWorkerIds = ids;
    return [];
  };

  recovery.runOnce();

  expect(capturedStaleWorkerIds.length).toBe(50); // MAX_STALE_WORKERS_PER_CALL
  expect(capturedStaleWorkerIds[0]).toBe("worker-0");
  expect(capturedStaleWorkerIds[49]).toBe("worker-49");
});

test("OrphanHandoffRecoveryService interval survives runOnce errors", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { intervalMs: 1 });

  let callCount = 0;
  recovery.runOnce = () => {
    callCount++;
    if (callCount === 1) throw new Error("Transient failure");
    return {
      requeued: 0,
      exhausted: 0,
      exhaustedRowIds: [],
      requeuedRowIds: [],
      _exhaustedRows: [],
      _requeuedRows: [],
    };
  };

  const { stop } = recovery.start();

  // Wait for at least 2 ticks
  await new Promise((r) => setTimeout(r, 50));
  stop();

  expect(callCount).toBeGreaterThan(1);
});

test("OrphanHandoffRecoveryService transaction atomicity rolls back on event record failure", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c",
          triggered_by_event_id: "e",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1));

  // Mock record to throw on first call
  const originalRecord = services.dispatchEventLog.record.bind(services.dispatchEventLog);
  let calls = 0;
  services.dispatchEventLog.record = (event: any) => {
    calls++;
    if (calls === 1) {
      throw new Error("Simulated event record failure");
    }
    return originalRecord(event);
  };

  // Run recovery - should fail and rollback because of the throw
  expect(() => recovery.runOnce()).toThrow("Simulated event record failure");

  // Assert handoff status didn't change (still dispatched)
  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("dispatched"); // did not change to approved (requeued)

  // Run recovery again - this time it succeeds
  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  // Assert handoff status is now approved (requeued)
  const finalRow = services.handoffReader.get(c1.handoff_id);
  expect(finalRow?.status).toBe("approved");
});

test("OrphanHandoffRecoveryService failFastMode always exhausts orphans", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0, failFastMode: true });

  const w1 = "dead-worker-fast";
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c-fast",
          triggered_by_event_id: "e-fast",
          max_dispatch_attempts: 9,
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await new Promise((r) => setTimeout(r, 1));

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 1 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("failed");
});

test("OrphanHandoffRecoveryService lists orphans ordered by ts ASC", async () => {
  const services = tempServices();
  const w1 = "dead-worker-1";

  // Create 3 orphans
  const c1 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m1",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    )
  ).json();
  const c2 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m2",
          conversation_id: "c2",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    )
  ).json();
  const c3 = await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m3",
          conversation_id: "c3",
          triggered_by_event_id: "e3",
        }),
      }),
      services,
    )
  ).json();

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c1.handoff_id, w1);

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c2.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c2.handoff_id, w1);

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c3.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(c3.handoff_id, w1);

  // Force timestamps so c2 is first, c3 is second, c1 is third (out of insertion order)
  services.db
    .query(`UPDATE handoffs SET ts = '2026-05-20T00:00:03Z' WHERE handoff_id = ?`)
    .run(c1.handoff_id);
  services.db
    .query(`UPDATE handoffs SET ts = '2026-05-20T00:00:01Z' WHERE handoff_id = ?`)
    .run(c2.handoff_id);
  services.db
    .query(`UPDATE handoffs SET ts = '2026-05-20T00:00:02Z' WHERE handoff_id = ?`)
    .run(c3.handoff_id);

  const orphans = services.handoffReader.listOrphanedDispatches([w1]);

  expect(orphans.length).toBe(3);
  expect(orphans[0].handoff_id).toBe(c2.handoff_id); // 00:00:01
  expect(orphans[1].handoff_id).toBe(c3.handoff_id); // 00:00:02
  expect(orphans[2].handoff_id).toBe(c1.handoff_id); // 00:00:03
});
