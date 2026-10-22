import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handoffsApproveRoute, handoffsCreateRoute } from "@src/routes/handoffs.js";
import { WatchdogService } from "@src/services/watchdog.js";
import { DEFAULT_WORKER_HEARTBEAT_STALE_MS } from "@src/worker-heartbeat-stale.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface HandoffCreated {
  handoff_id: string;
}

function internals(w: WatchdogService): { lastHeartbeats: Map<string, number> } {
  return w as unknown as { lastHeartbeats: Map<string, number> };
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  return buildServices({
    env: {},
    input: {},
    storageRoot: root,
    worktreeRootDir: join(root, "worktrees"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `e-${String(++n)}`;
    })(),
  });
}

test("WatchdogService fails handoffs for timed-out workers", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;

  const w1 = "worker-1";
  const w2 = "worker-2";

  // 1. Seed two handoffs for different workers
  const c1 = (await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    )
  ).json()) as HandoffCreated;
  const c2 = (await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c2",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    )
  ).json()) as HandoffCreated;

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c2.handoff_id,
    services,
  );

  services.handoffWriter.claimDispatch(c1.handoff_id, w1);
  services.handoffWriter.claimDispatch(c2.handoff_id, w2);

  // 2. Record heartbeats
  watchdog.recordHeartbeat(w1);
  watchdog.recordHeartbeat(w2);

  // 3. Simulate timeout for w1
  internals(watchdog).lastHeartbeats.set(w1, Date.now() - 100_000); // timed out
  internals(watchdog).lastHeartbeats.set(w2, Date.now()); // healthy

  // 4. Tick
  await watchdog.tick();

  // 5. Verify: c1 failed, c2 still dispatched
  const r1 = services.handoffReader.get(c1.handoff_id);
  const r2 = services.handoffReader.get(c2.handoff_id);

  expect(r1?.status).toBe("failed");
  expect(r1?.resolution_reason).toBe("worker timeout");
  expect(r2?.status).toBe("dispatched");

  const allEvents = [
    ...services.dispatchEventLog.listByHandoff(""),
    ...services.dispatchEventLog.listByHandoff(c1.handoff_id),
  ];
  expect(allEvents.some((event) => event.kind === "watchdog.tick")).toBe(true);
  expect(
    allEvents.some(
      (event) => event.kind === "watchdog.auto_fail" && event.handoff_id === c1.handoff_id,
    ),
  ).toBe(true);
});

test("WatchdogService emits notification-shaped metadata for timed-out handoffs", async () => {
  const services = tempServices();
  const events: unknown[] = [];
  services.notificationEvents = {
    emit(event: unknown): void {
      events.push(event);
    },
  };

  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;

  const worker_id = "worker-primary";
  const c1 = (await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "codex",
          project_id: "penumbra",
          message: "m",
          conversation_id: "c-1",
          triggered_by_event_id: "e-1",
        }),
      }),
      services,
    )
  ).json()) as HandoffCreated;

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );

  services.handoffWriter.claimDispatch(c1.handoff_id, worker_id);

  watchdog.recordHeartbeat(worker_id);
  internals(watchdog).lastHeartbeats.set(worker_id, Date.now() - 100_000);

  await watchdog.tick();

  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    kind: "watchdog_failure",
    worker_id,
    handoff_id: c1.handoff_id,
    conversation_id: "c-1",
    project_id: "penumbra",
    agent: "codex",
    error_summary: "worker timeout",
  });
});

test("WatchdogService does not fail a reassigned handoff during stale worker reap", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;
  services.orphanHandoffRecovery = undefined;

  const stale_worker_id = "worker-stale";
  const reassigned_worker_id = "worker-live";
  const c1 = (await (
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "codex",
          message: "m",
          conversation_id: "c-2",
          triggered_by_event_id: "e-2",
        }),
      }),
      services,
    )
  ).json()) as HandoffCreated;

  await handoffsApproveRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    c1.handoff_id,
    services,
  );

  services.handoffWriter.claimDispatch(c1.handoff_id, stale_worker_id);
  watchdog.recordHeartbeat(stale_worker_id);

  services.db.run("UPDATE handoffs SET worker_id=? WHERE handoff_id=?", [
    reassigned_worker_id,
    c1.handoff_id,
  ]);

  internals(watchdog).lastHeartbeats.set(stale_worker_id, Date.now() - 100_000);
  await watchdog.tick();

  const row = services.handoffReader.get(c1.handoff_id);
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe(reassigned_worker_id);
});

const STALE_MS_KEY = "PENUMBRA_WORKER_HEARTBEAT_STALE_MS";
const previousStaleMs = process.env[STALE_MS_KEY];

afterEach(() => {
  if (previousStaleMs === undefined) Reflect.deleteProperty(process.env, STALE_MS_KEY);
  else process.env[STALE_MS_KEY] = previousStaleMs;
});

async function reapedAfterTick(
  watchdog: WatchdogService,
  heartbeatAgeMs: number,
): Promise<boolean> {
  internals(watchdog).lastHeartbeats.set("w-aged", Date.now() - heartbeatAgeMs);
  await watchdog.tick();
  return !watchdog.hasWorker("w-aged");
}

test("WatchdogService built without a timeout falls back to the default for a negative env value", async () => {
  process.env[STALE_MS_KEY] = "-5000";
  const services = tempServices();

  expect(
    await reapedAfterTick(new WatchdogService(services), DEFAULT_WORKER_HEARTBEAT_STALE_MS - 1000),
  ).toBe(false);
  expect(
    await reapedAfterTick(new WatchdogService(services), DEFAULT_WORKER_HEARTBEAT_STALE_MS + 1000),
  ).toBe(true);
});

test("WatchdogService built without a timeout honours a positive env value", async () => {
  process.env[STALE_MS_KEY] = "1500";
  const services = tempServices();

  expect(await reapedAfterTick(new WatchdogService(services), 500)).toBe(false);
  expect(await reapedAfterTick(new WatchdogService(services), 2500)).toBe(true);
});

test("WatchdogService prefers an explicit timeout over the env value", async () => {
  process.env[STALE_MS_KEY] = "1500";
  const services = tempServices();

  expect(await reapedAfterTick(new WatchdogService(services, 60_000), 2500)).toBe(false);
  expect(await reapedAfterTick(new WatchdogService(services, 60_000), 61_000)).toBe(true);
});
