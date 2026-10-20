import {
  buildServices,
  type DispatchEventInput,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { handoffsApproveRoute, handoffsCreateRoute } from "@src/routes/handoffs.js";
import { OrphanHandoffRecoveryService } from "@src/services/orphan-handoff-recovery.js";
import { WatchdogService } from "@src/services/watchdog.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

interface CreatedHandoff {
  handoff_id: string;
  status: "pending";
}

interface CreatePendingHandoffInput {
  conversation_id?: string;
  max_dispatch_attempts?: number;
  message?: string;
  triggered_by_event_id?: string;
}

function parseCreatedHandoff(value: unknown): CreatedHandoff {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected handoff create response object");
  }
  if (!("handoff_id" in value) || typeof value.handoff_id !== "string") {
    throw new Error("expected handoff_id in create response");
  }
  if (!("status" in value) || value.status !== "pending") {
    throw new Error("expected pending status in create response");
  }
  return { handoff_id: value.handoff_id, status: value.status };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      return (): string => `e-${String(++n)}`;
    })(),
  });
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;
  return services;
}

async function createPendingHandoff(
  services: Services,
  input: CreatePendingHandoffInput = {},
): Promise<CreatedHandoff> {
  const response = await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: input.message ?? "m",
        conversation_id: input.conversation_id ?? "c",
        triggered_by_event_id: input.triggered_by_event_id ?? "e",
        ...(input.max_dispatch_attempts === undefined
          ? {}
          : { max_dispatch_attempts: input.max_dispatch_attempts }),
      }),
    }),
    services,
  );
  return parseCreatedHandoff(await response.json());
}

async function approveAndClaim(
  services: Services,
  handoffId: string,
  workerId: string,
): Promise<void> {
  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    handoffId,
    services,
  );
  services.handoffWriter.claimDispatch(handoffId, workerId);
}

async function createDispatchedHandoff(services: Services, workerId: string): Promise<string> {
  const created = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, created.handoff_id, workerId);
  return created.handoff_id;
}

function setLastDispatchStartedAt(services: Services, handoffId: string, ts: string): void {
  services.db
    .query<
      never,
      [string, string]
    >("UPDATE handoffs SET last_dispatch_started_at=? WHERE handoff_id=?")
    .run(ts, handoffId);
}

function recordDispatchStart(
  services: Services,
  handoffId: string,
  workerId: string,
  ts: string,
): void {
  services.dispatchEventLog.record({
    handoff_id: handoffId,
    source: "worker",
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

test("OrphanHandoffRecoveryService ignores old dispatch.start events for a never-heartbeat worker when current dispatch start column is recent", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 60_000 });

  const workerId = "redispatched-fresh-worker";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const oldDeadAttempt = new Date(Date.now() - 600_000).toISOString();
  const recent = new Date(Date.now()).toISOString();
  setLastDispatchStartedAt(services, handoffId, recent);
  recordDispatchStart(services, handoffId, workerId, oldDeadAttempt);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe(workerId);
});

test("OrphanHandoffRecoveryService does not recover started dispatches for recently heartbeated workers on periodic sweep", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 1000 });

  const workerId = "recent-heartbeat-worker";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const recent = new Date(Date.now()).toISOString();
  setLastDispatchStartedAt(services, handoffId, recent);
  recordDispatchStart(services, handoffId, workerId, recent);

  services.watchdog.recordHeartbeat(workerId);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe(workerId);
});

test("OrphanHandoffRecoveryService can recover recent started dispatches when worker is known dead", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 1000 });

  const workerId = "known-dead-started-worker";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const recent = new Date(Date.now()).toISOString();
  setLastDispatchStartedAt(services, handoffId, recent);
  recordDispatchStart(services, handoffId, workerId, recent);
  services.watchdog.recordHeartbeat(workerId);

  const result = recovery.recoverForWorker(workerId, { workerKnownDead: true });
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("OrphanHandoffRecoveryService requeues when attempts < max", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 }); // 0 ms means everything is stale

  const w1 = "dead-worker-1";

  const c1 = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1); // Ensure Date.now() is slightly later

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
  const c1 = await createPendingHandoff(services);
  await approveAndClaim(services, c1.handoff_id, w1);
  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  await Promise.all([recovery.recoverAll(), recovery.recoverAll(), recovery.recoverAll()]);

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("approved");
  const events = services.dispatchEventLog.listByHandoff(c1.handoff_id);
  expect(events.filter((event) => event.kind === "worker.recovery.requeued")).toHaveLength(1);
});

test("OrphanHandoffRecoveryService fails when attempts == max", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";

  const c1 = await createPendingHandoff(services);
  services.db
    .query<never, [string]>("UPDATE handoffs SET max_dispatch_attempts=1 WHERE handoff_id=?")
    .run(c1.handoff_id);

  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

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
  const c1 = await createPendingHandoff(services);
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

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
  const c1 = await createPendingHandoff(services);
  await approveAndClaim(services, c1.handoff_id, w1);

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

  const c1 = await createPendingHandoff(services, {
    conversation_id: "c1",
    message: "m1",
    triggered_by_event_id: "e1",
  });
  const c2 = await createPendingHandoff(services, {
    conversation_id: "c2",
    message: "m2",
    triggered_by_event_id: "e2",
  });

  await approveAndClaim(services, c1.handoff_id, w1);
  await approveAndClaim(services, c2.handoff_id, w2);

  services.watchdog.recordHeartbeat(w1);
  services.watchdog.recordHeartbeat(w2);
  await delay(1);

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

  const c1 = await createPendingHandoff(services);
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1); // fresh

  const result = recovery.runOnce(w1);
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 }); // should requeue despite being fresh in watchdog

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("approved"); // requeued
});

test("OrphanHandoffRecoveryService runOnce(workerId) requeues never-heartbeat deep-stale dispatch-started handoff", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 1000 });

  const workerId = "never-heartbeat-worker-single";
  const handoffId = await createDispatchedHandoff(services, workerId);
  const deepStale = new Date(Date.now() - 10_000).toISOString();
  setLastDispatchStartedAt(services, handoffId, deepStale);
  recordDispatchStart(services, handoffId, workerId, deepStale);

  const result = recovery.runOnce(workerId);
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row = services.handoffReader.get(handoffId);
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("OrphanHandoffRecoveryService runOnce(workerId, {claimedBefore}) reconciles only rows claimed before the bound", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 60_000 });

  const w = "rebooted-worker";
  const bound = "2026-10-06T12:00:00.000Z";

  const claimedBefore = await createDispatchedHandoff(services, w);
  const claimedAt = await createDispatchedHandoff(services, w);
  const claimedAfter = await createDispatchedHandoff(services, w);
  const unstamped = await createDispatchedHandoff(services, w);

  setLastDispatchStartedAt(services, claimedBefore, "2026-10-06T11:59:59.000Z");
  setLastDispatchStartedAt(services, claimedAt, bound);
  setLastDispatchStartedAt(services, claimedAfter, "2026-10-06T12:00:01.000Z");
  // A row that predates last_dispatch_started_at: the current incarnation always
  // stamps, so NULL can only be a legacy claim — still rescued.
  services.db
    .query<never, [string]>("UPDATE handoffs SET last_dispatch_started_at=NULL WHERE handoff_id=?")
    .run(unstamped);

  const result = recovery.runOnce(w, { workerKnownDead: true, claimedBefore: bound });
  expect(result).toMatchObject({ requeued: 2, exhausted: 0 });
  expect([...result.requeuedRowIds].sort()).toEqual([claimedBefore, unstamped].sort());

  expect(services.handoffReader.get(claimedBefore)?.status).toBe("approved");
  expect(services.handoffReader.get(unstamped)?.status).toBe("approved");
  expect(services.handoffReader.get(claimedAt)).toMatchObject({
    status: "dispatched",
    worker_id: w,
  });
  expect(services.handoffReader.get(claimedAfter)).toMatchObject({
    status: "dispatched",
    worker_id: w,
  });
});

test("OrphanHandoffRecoveryService runOnce(workerId) without claimedBefore keeps reconciling every dispatched row", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 60_000 });

  const w = "rebooted-worker-nb";
  const h1 = await createDispatchedHandoff(services, w);
  const h2 = await createDispatchedHandoff(services, w);
  setLastDispatchStartedAt(services, h1, "2026-10-06T11:00:00.000Z");
  setLastDispatchStartedAt(services, h2, "2999-01-01T00:00:00.000Z");

  const result = recovery.runOnce(w, { workerKnownDead: true });
  expect(result).toMatchObject({ requeued: 2, exhausted: 0 });
});

test("OrphanHandoffRecoveryService caps stale workers per call", () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const manyWorkers = Array.from({ length: 100 }, (_, i): string => `worker-${String(i)}`);
  services.watchdog.getStaleWorkers = (): string[] => manyWorkers;

  let listOrphanedCalls = 0;
  let capturedStaleWorkerIds: string[] = [];
  services.handoffReader.listOrphanedDispatches = (ids: string[]): [] => {
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
  recovery.runOnce = (): ReturnType<OrphanHandoffRecoveryService["runOnce"]> => {
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
  await delay(50);
  stop();

  expect(callCount).toBeGreaterThan(1);
});

test("OrphanHandoffRecoveryService transaction atomicity rolls back on event record failure", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-1";
  const c1 = await createPendingHandoff(services);
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const originalRecord = services.dispatchEventLog.record.bind(services.dispatchEventLog);
  let calls = 0;
  services.dispatchEventLog.record = (event: DispatchEventInput): void => {
    calls++;
    if (calls === 1) {
      throw new Error("Simulated event record failure");
    }
    originalRecord(event);
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
  const c1 = await createPendingHandoff(services, {
    conversation_id: "c-fast",
    max_dispatch_attempts: 9,
    triggered_by_event_id: "e-fast",
  });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 0, exhausted: 1 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("failed");
});

test("OrphanHandoffRecoveryService lists orphans ordered by ts ASC", async () => {
  const services = tempServices();
  const w1 = "dead-worker-1";

  const c1 = await createPendingHandoff(services, {
    conversation_id: "c1",
    message: "m1",
    triggered_by_event_id: "e1",
  });
  const c2 = await createPendingHandoff(services, {
    conversation_id: "c2",
    message: "m2",
    triggered_by_event_id: "e2",
  });
  const c3 = await createPendingHandoff(services, {
    conversation_id: "c3",
    message: "m3",
    triggered_by_event_id: "e3",
  });

  await approveAndClaim(services, c1.handoff_id, w1);
  await approveAndClaim(services, c2.handoff_id, w1);
  await approveAndClaim(services, c3.handoff_id, w1);

  // Force timestamps so c2 is first, c3 is second, c1 is third (out of insertion order)
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts = ? WHERE handoff_id = ?")
    .run("2026-05-20T00:00:03Z", c1.handoff_id);
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts = ? WHERE handoff_id = ?")
    .run("2026-05-20T00:00:01Z", c2.handoff_id);
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts = ? WHERE handoff_id = ?")
    .run("2026-05-20T00:00:02Z", c3.handoff_id);

  const orphans = services.handoffReader.listOrphanedDispatches([w1]);

  expect(orphans.length).toBe(3);
  expect(orphans[0].handoff_id).toBe(c2.handoff_id); // 00:00:01
  expect(orphans[1].handoff_id).toBe(c3.handoff_id); // 00:00:02
  expect(orphans[2].handoff_id).toBe(c1.handoff_id); // 00:00:03
});

test("OrphanHandoffRecoveryService re-offers requeued rows for non-capped providers on the worker bus", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-non-capped";
  const c1 = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();

  expect(emitted.some((r) => r.handoff_id === c1.handoff_id && r.status === "approved")).toBe(true);

  const reofferRows = services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .all(c1.handoff_id);
  expect(reofferRows).toHaveLength(1);
  expect(JSON.parse(reofferRows[0]?.meta_json ?? "{}")).toMatchObject({
    cause: "orphan_requeue",
    from_worker_id: w1,
  });
});

test("OrphanHandoffRecoveryService emits re-offer even when claim.reoffer event recording fails", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-reoffer-record-fails";
  const c1 = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));

  const originalRecord = services.dispatchEventLog.record.bind(services.dispatchEventLog);
  services.dispatchEventLog.record = (event: DispatchEventInput): void => {
    if (event.kind === "claim.reoffer") {
      throw new Error("claim.reoffer record failed");
    }
    originalRecord(event);
  };

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });
  expect(emitted.some((row) => row.handoff_id === c1.handoff_id && row.status === "approved")).toBe(
    true,
  );
});

test("OrphanHandoffRecoveryService emits re-offer before telemetry can observe a re-claim race", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-reclaim-race";
  const c1 = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const observedStatusesAtEmit: (HandoffRow["status"] | null)[] = [];
  services.handoffEvents.subscribe((row) => {
    if (row.handoff_id === c1.handoff_id) {
      observedStatusesAtEmit.push(services.handoffReader.get(c1.handoff_id)?.status ?? null);
    }
  });

  const originalRecord = services.dispatchEventLog.record.bind(services.dispatchEventLog);
  services.dispatchEventLog.record = (event: DispatchEventInput): void => {
    if (event.kind === "claim.reoffer") {
      services.handoffWriter.claimDispatch(c1.handoff_id, "racing-worker");
    }
    originalRecord(event);
  };

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });
  expect(observedStatusesAtEmit).toEqual(["approved"]);
  expect(services.handoffReader.get(c1.handoff_id)?.status).toBe("dispatched");
});

test("OrphanHandoffRecoveryService continues re-offer batch when one deleted row cannot record telemetry", async () => {
  const services = tempServices();
  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-deleted-reoffer";
  const c1 = await createPendingHandoff(services, {
    conversation_id: "deleted-row",
    max_dispatch_attempts: 3,
    triggered_by_event_id: "e-deleted",
  });
  const c2 = await createPendingHandoff(services, {
    conversation_id: "surviving-row",
    max_dispatch_attempts: 3,
    triggered_by_event_id: "e-surviving",
  });
  await approveAndClaim(services, c1.handoff_id, w1);
  await approveAndClaim(services, c2.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const emitted: string[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row.handoff_id));

  const originalRecord = services.dispatchEventLog.record.bind(services.dispatchEventLog);
  services.dispatchEventLog.record = (event: DispatchEventInput): void => {
    if (event.kind === "claim.reoffer" && event.handoff_id === c1.handoff_id) {
      services.db
        .query<never, [string]>("DELETE FROM handoffs WHERE handoff_id=?")
        .run(c1.handoff_id);
      throw new Error("handoff disappeared before telemetry");
    }
    originalRecord(event);
  };

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 2, exhausted: 0 });
  expect(emitted).toContain(c1.handoff_id);
  expect(emitted).toContain(c2.handoff_id);
  expect(services.handoffReader.get(c1.handoff_id)).toBeNull();
  expect(services.handoffReader.get(c2.handoff_id)?.status).toBe("approved");
});

test("OrphanHandoffRecoveryService does not re-offer requeued rows for capped providers (reoffer reactor owns that path)", async () => {
  const services = tempServices();
  services.agentchatConfig = {
    agents: [
      {
        name: "b",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
    ],
  };
  services.providerQuotas = [{ provider: "anthropic", max_in_flight: 1 }];

  const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });

  const w1 = "dead-worker-capped";
  const c1 = await createPendingHandoff(services, { max_dispatch_attempts: 3 });
  await approveAndClaim(services, c1.handoff_id, w1);

  services.watchdog.recordHeartbeat(w1);
  await delay(1);

  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));

  const result = recovery.runOnce();
  expect(result).toMatchObject({ requeued: 1, exhausted: 0 });

  expect(emitted).toEqual([]);

  const reofferRows = services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .all(c1.handoff_id);
  expect(reofferRows).toHaveLength(0);
});
