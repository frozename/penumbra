import {
  buildServices,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { handoffsCompleteRoute } from "@src/routes/handoffs.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { OrphanHandoffRecoveryService } from "@src/services/orphan-handoff-recovery.js";
import { createProviderCapacityReoffer } from "@src/services/provider-capacity-reoffer.js";
import { WatchdogService } from "@src/services/watchdog.js";
import { runStaleHandoffSweep } from "@src/sweepers/stale-handoff.js";
import { createHandoffSweeperWorker } from "@src/workers/handoff-sweeper.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";

function tempServices(clock: () => Date = () => new Date("2026-05-21T10:00:00Z")): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/provider-capacity-reoffer-sites-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock,
    uuid: (() => {
      let n = 0;
      return () => `e-${String(++n)}`;
    })(),
  });
}

function configureProviderCap(services: Services, max_in_flight: number): void {
  services.agentchatConfig = {
    agents: [
      {
        name: "claude-a",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "claude-b",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
    ],
  };
  services.providerQuotas = [{ provider: "anthropic", max_in_flight }];
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

function seedApprovedHandoff(
  services: Services,
  handoff_id: string,
  opts: { to?: string; ts?: string; tsOffsetMs?: number } = {},
): void {
  const ts =
    opts.ts ??
    new Date(Date.parse("2026-05-21T10:00:00.000Z") + (opts.tsOffsetMs ?? 0)).toISOString();
  services.handoffWriter.createApproved({
    handoff_id,
    ts,
    project_id: null,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: opts.to ?? "claude-a",
    to_role: null,
    message: "go",
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: "2026-05-21T10:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    dispatch_kind: null,
    workflow_run_id: null,
  });
}

function setup(clock?: () => Date): { services: Services; emitted: HandoffRow[] } {
  const services = tempServices(clock);
  configureProviderCap(services, 1);
  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));
  createProviderCapacityReoffer({ services }).start();
  return { services, emitted };
}

function seedRunningAndWaiting(services: Services, emitted: HandoffRow[]): void {
  seedApprovedHandoff(services, "running", { to: "claude-a" });
  seedApprovedHandoff(services, "waiting", { to: "claude-b", tsOffsetMs: 1 });
  emitted.length = 0;
}

function assertReoffered(services: Services, emitted: HandoffRow[], to_status: string): void {
  expect(emitted.some((row) => row.handoff_id === "waiting" && row.status === "approved")).toBe(
    true,
  );
  const row = services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .get("waiting");
  expect(JSON.parse(row?.meta_json ?? "{}")).toMatchObject({
    freed_by: "running",
    to_status,
  });
}

test("complete route re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const claim = await fetchHandler(
    new Request("http://x/handoffs/running/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(claim.status).toBe(200);
  emitted.length = 0;

  const res = await fetchHandler(
    new Request("http://x/handoffs/running/complete", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: "{}",
    }),
  );

  expect(res.status).toBe(200);
  assertReoffered(services, emitted, "completed");
});

test("fail route re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  expect(
    await fetchHandler(
      new Request("http://x/handoffs/running/claim", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "W-A" }),
      }),
    ),
  ).toHaveProperty("status", 200);
  emitted.length = 0;

  const res = await fetchHandler(
    new Request("http://x/handoffs/running/fail", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ reason: "boom" }),
    }),
  );

  expect(res.status).toBe(200);
  assertReoffered(services, emitted, "failed");
});

test("cancel fallback re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  services.handoffWriter.requestCancellation("conv-running", "2026-05-21T10:00:01.000Z");
  emitted.length = 0;

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST", body: "{}" }),
    "running",
    services,
  );
  const body = (await res.json()) as { status: string; reason: string };

  expect(body).toMatchObject({ status: "failed", reason: "cancelled" });
  assertReoffered(services, emitted, "failed");
});

test("orphan requeue re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;
  expect(services.handoffWriter.claimDispatch("running", "dead")).toBe(true);
  watchdog.recordHeartbeat("dead");
  (watchdog as unknown as { lastHeartbeats: Map<string, number> }).lastHeartbeats.set(
    "dead",
    Date.now() - 100_000,
  );
  emitted.length = 0;

  const result = new OrphanHandoffRecoveryService(services, { staleMs: 0 }).runOnce();
  await Promise.resolve();
  await Promise.resolve();

  expect(result.requeued).toBe(1);
  assertReoffered(services, emitted, "approved");
});

test("orphan exhausted re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;
  expect(services.handoffWriter.claimDispatch("running", "dead")).toBe(true);
  watchdog.recordHeartbeat("dead");
  (watchdog as unknown as { lastHeartbeats: Map<string, number> }).lastHeartbeats.set(
    "dead",
    Date.now() - 100_000,
  );
  emitted.length = 0;

  const result = new OrphanHandoffRecoveryService(services, {
    staleMs: 0,
    failFastMode: true,
  }).runOnce();
  await Promise.resolve();
  await Promise.resolve();

  expect(result.exhausted).toBe(1);
  assertReoffered(services, emitted, "failed");
});

test("stale sweeper force-resolve holds the slot until the worker reports dispatch.end, then the sweep re-offers", async () => {
  const { services, emitted } = setup(() => new Date("2026-05-04T12:00:00.000Z"));
  seedRunningAndWaiting(services, emitted);
  new WorkerTokenStore(services.db).issue({ worker_id: "W-A" }, Date.now());
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts=? WHERE handoff_id=?")
    .run("2026-05-04T11:50:00.000Z", "running");
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  services.dispatchEventLog.record({
    handoff_id: "running",
    worker_id: "W-A",
    source: "worker",
    kind: "dispatch.start",
    ts: "2026-05-04T11:50:01.000Z",
  });
  emitted.length = 0;

  const result = runStaleHandoffSweep(
    { services },
    { lastSwept: new Map() },
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  await Promise.resolve();
  await Promise.resolve();

  expect(result.resolved).toEqual(["running"]);
  expect(emitted.some((r) => r.handoff_id === "waiting")).toBe(false);

  services.dispatchEventLog.record({
    handoff_id: "unrelated",
    worker_id: "W-B",
    source: "worker",
    kind: "dispatch.end",
    ts: "2026-05-04T12:00:00.500Z",
  });
  createProviderCapacityReoffer({ services }).sweep();
  expect(emitted.some((r) => r.handoff_id === "waiting")).toBe(false);

  services.dispatchEventLog.record({
    handoff_id: "running",
    worker_id: "W-A",
    source: "worker",
    kind: "dispatch.end",
    ts: "2026-05-04T12:00:01.000Z",
  });
  createProviderCapacityReoffer({ services }).sweep();

  expect(emitted.some((r) => r.handoff_id === "waiting" && r.status === "approved")).toBe(true);
  const reofferRow = services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .get("waiting");
  expect(JSON.parse(reofferRow?.meta_json ?? "{}")).toMatchObject({ cause: "sweep" });
});

test("stale sweeper force-resolve re-offers at once when the swept worker is not live", async () => {
  const { services, emitted } = setup(() => new Date("2026-05-04T12:00:00.000Z"));
  seedRunningAndWaiting(services, emitted);
  new WorkerTokenStore(services.db).issue({ worker_id: "W-A" }, Date.now() - 10 * 60_000);
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts=? WHERE handoff_id=?")
    .run("2026-05-04T11:50:00.000Z", "running");
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  services.dispatchEventLog.record({
    handoff_id: "running",
    worker_id: "W-A",
    source: "worker",
    kind: "dispatch.start",
    ts: "2026-05-04T11:50:01.000Z",
  });
  emitted.length = 0;

  const result = runStaleHandoffSweep(
    { services },
    { lastSwept: new Map() },
    () => new Date("2026-05-04T12:00:00.000Z"),
  );
  await Promise.resolve();
  await Promise.resolve();

  expect(result.resolved).toEqual(["running"]);
  assertReoffered(services, emitted, "failed");
});

test("watchdog fallback re-offers", async () => {
  const { services, emitted } = setup();
  seedRunningAndWaiting(services, emitted);
  const watchdog = new WatchdogService(services);
  services.watchdog = watchdog;
  services.orphanHandoffRecovery = undefined;
  expect(services.handoffWriter.claimDispatch("running", "worker-stale")).toBe(true);
  watchdog.recordHeartbeat("worker-stale");
  (watchdog as unknown as { lastHeartbeats: Map<string, number> }).lastHeartbeats.set(
    "worker-stale",
    Date.now() - 100_000,
  );
  emitted.length = 0;

  await watchdog.tick();

  assertReoffered(services, emitted, "failed");
});

test("TTL sweeper expiry re-offers", async () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const { services, emitted } = setup(() => now);
  seedRunningAndWaiting(services, emitted);
  const oldTs = new Date(now.getTime() - 35 * 60_000).toISOString();
  services.db
    .query<never, [string, string]>("UPDATE handoffs SET ts=? WHERE handoff_id=?")
    .run(oldTs, "running");
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  emitted.length = 0;

  await createHandoffSweeperWorker({ services }).tick();

  expect(services.handoffReader.get("running")?.status).toBe("expired");
  assertReoffered(services, emitted, "expired");
});
