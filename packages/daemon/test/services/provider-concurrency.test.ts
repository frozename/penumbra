import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import { workerHeartbeatStaleMs } from "@src/routes/worker-profile-gate.js";
import {
  countProviderInFlight,
  listCappedProviders,
  type ProviderConcurrencyDecision,
  recordProviderCapRefusal,
  resolveProviderConcurrencyDecision,
  resolveProviderSeatNames,
  STALE_SWEEP_DRAIN_MAX_HOLD_MS,
  sweeperDrainingCountSql,
} from "@src/services/provider-concurrency.js";
import { WatchdogService } from "@src/services/watchdog.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

afterEach(() => {
  setSystemTime();
});

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/provider-concurrency-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
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

test("resolveProviderConcurrencyDecision returns null with no agentchatConfig, no cap, or a model-scoped-only quota", () => {
  const services = tempServices();

  expect(resolveProviderConcurrencyDecision(services, { to_agent: "claude-a" })).toBeNull();

  configureProviderCap(services, 1);
  services.providerQuotas = [];
  expect(resolveProviderConcurrencyDecision(services, { to_agent: "claude-a" })).toBeNull();

  services.providerQuotas = [{ provider: "anthropic", model: "claude-x", max_in_flight: 1 }];
  expect(resolveProviderConcurrencyDecision(services, { to_agent: "claude-a" })).toBeNull();
});

test("listCappedProviders returns only provider-wide max_in_flight rows", () => {
  const services = tempServices();
  services.providerQuotas = [
    { provider: "google", model: "gemini-x", max_in_flight: 1 },
    { provider: "google", max_in_flight: 2 },
    { provider: "openai" },
  ];

  expect(listCappedProviders(services)).toEqual([{ provider: "google", max_in_flight: 2 }]);
  expect(
    listCappedProviders({ providerQuotas: undefined } as unknown as Pick<
      Services,
      "providerQuotas"
    >),
  ).toEqual([]);
});

test("resolveProviderSeatNames returns every seat resolving to the provider", () => {
  const services = tempServices();
  configureProviderCap(services, 1);

  expect(resolveProviderSeatNames(services, "anthropic")).toEqual(["claude-a", "claude-b"]);
  expect(resolveProviderSeatNames(services, "google")).toEqual([]);
});

test("recordProviderCapRefusal logs info every time and records claim.provider_cap_refused once per handoff on precheck but every time on cas_loss", () => {
  const services = tempServices();
  const log = { info: mock(), warn: mock(), debug: mock(), error: mock() };
  services.log = log as unknown as Services["log"];
  const decision: ProviderConcurrencyDecision = {
    provider: "anthropic",
    providerSeatNames: ["claude-a", "claude-b"],
    max_in_flight: 1,
    in_flight_count: 1,
  };

  recordProviderCapRefusal(services, {
    handoff_id: "h",
    worker_id: "W-B",
    decision,
    path: "precheck",
  });
  recordProviderCapRefusal(services, {
    handoff_id: "h",
    worker_id: "W-B",
    decision,
    path: "precheck",
  });
  recordProviderCapRefusal(services, {
    handoff_id: "h",
    worker_id: "W-B",
    decision,
    path: "cas_loss",
  });

  expect(log.info).toHaveBeenCalledTimes(3);
  expect(log.info).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      handoff_id: "h",
      worker_id: "W-B",
      provider: "anthropic",
      max_in_flight: 1,
      in_flight_count: 1,
      path: "precheck",
    }),
    "claim refused: provider in-flight cap",
  );
  expect(log.info).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      handoff_id: "h",
      worker_id: "W-B",
      provider: "anthropic",
      max_in_flight: 1,
      in_flight_count: 1,
      path: "cas_loss",
    }),
    "claim refused: provider in-flight cap",
  );
  const row = services.db
    .query<
      { n: number },
      []
    >("SELECT COUNT(*) AS n FROM dispatch_events WHERE handoff_id='h' AND kind='claim.provider_cap_refused'")
    .get();
  expect(row?.n).toBe(2);
});

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

const SWEEP_TS = "2026-05-21T10:00:00.000Z";
const SEATS = ["claude-a", "claude-b"];

function claimed(services: Services, handoff_id: string, to = "claude-a", tsOffsetMs = 0): void {
  seedApprovedHandoff(services, handoff_id, { to, tsOffsetMs });
  expect(services.handoffWriter.claimDispatch(handoff_id, "W-A")).toBe(true);
}

function insertSweeperDispatchEnd(services: Services, handoff_id: string, ts = SWEEP_TS): void {
  services.db.run(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, NULL, 'sweeper', 'dispatch.end', ?, NULL)`,
    [handoff_id, ts],
  );
}

// Mirrors sweepers/stale-handoff.ts, which writes the force-fail and the sweeper
// dispatch.end row in one transaction.
function sweepLikeStaleSweeper(services: Services, handoff_id: string, ts = SWEEP_TS): void {
  services.db.transaction(() => {
    expect(
      services.handoffWriter.markFailed(handoff_id, {
        reason: "stale_force_resolve",
        resolved_by: "stale-handoff-sweeper",
        ts,
      }),
    ).toBe(true);
    insertSweeperDispatchEnd(services, handoff_id, ts);
  })();
}

function recordWorkerEvent(
  services: Services,
  handoff_id: string,
  kind: "dispatch.start" | "dispatch.end",
  ts = "2026-05-21T10:00:05.000Z",
): void {
  services.dispatchEventLog.record({ handoff_id, worker_id: "W-A", source: "worker", kind, ts });
}

// The heartbeat route touches worker_tokens.last_seen_at; issue() writes it as atMs.
function heartbeatAt(services: Services, worker_id: string, atMs: number): void {
  new WorkerTokenStore(services.db).issue({ worker_id }, atMs);
}

const count = (services: Services, seats: string[] = SEATS): number =>
  countProviderInFlight(services, seats);

describe("countProviderInFlight stale-sweep drain hold (#218)", () => {
  test("holds the slot after the sweep until the swept worker's own dispatch.end", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept");
    recordWorkerEvent(services, "h-swept", "dispatch.start", "2026-05-21T09:59:00.000Z");
    expect(count(services)).toBe(1);

    sweepLikeStaleSweeper(services, "h-swept");
    expect(count(services)).toBe(1);

    seedApprovedHandoff(services, "h-other", { tsOffsetMs: 1 });
    recordWorkerEvent(services, "h-other", "dispatch.end");
    expect(count(services)).toBe(1);

    recordWorkerEvent(services, "h-swept", "dispatch.end");
    expect(count(services)).toBe(0);
  });

  test("a swept handoff on a seat outside the list is not counted", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept", "codex-a");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(count(services)).toBe(0);
    expect(count(services, ["codex-a"])).toBe(1);
  });

  test("a non-sweeper failure does not hold even with a sweeper dispatch.end row", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-cancel");
    expect(
      services.handoffWriter.markFailed("h-cancel", {
        reason: "cancelled",
        resolved_by: "cancel",
        ts: SWEEP_TS,
      }),
    ).toBe(true);
    insertSweeperDispatchEnd(services, "h-cancel");

    expect(count(services)).toBe(0);
  });

  test("a swept handoff with no worker_id does not hold", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    seedApprovedHandoff(services, "h-unclaimed");
    sweepLikeStaleSweeper(services, "h-unclaimed");

    expect(count(services)).toBe(0);
  });

  test("a row that is not failed never counts as draining", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-live");
    services.db
      .query<
        never,
        []
      >("UPDATE handoffs SET resolved_by='stale-handoff-sweeper' WHERE handoff_id='h-live'")
      .run();
    insertSweeperDispatchEnd(services, "h-live");

    expect(count(services)).toBe(1);
  });

  test("the max-hold bound is inclusive at the cutoff", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    const sweptMs = Date.parse(SWEEP_TS);
    services.clock = (): Date => new Date(sweptMs + STALE_SWEEP_DRAIN_MAX_HOLD_MS);
    expect(count(services)).toBe(1);

    services.clock = (): Date => new Date(sweptMs + STALE_SWEEP_DRAIN_MAX_HOLD_MS + 1);
    expect(count(services)).toBe(0);
  });

  test("a swept worker with no fresh heartbeat releases the slot at once", () => {
    const services = tempServices();
    heartbeatAt(services, "W-OTHER", Date.now());
    heartbeatAt(services, "W-A", Date.now() - workerHeartbeatStaleMs() - 60_000);

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(count(services)).toBe(0);
  });

  test("the worker stale bound is inclusive", () => {
    const services = tempServices();
    const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
    setSystemTime(new Date(nowMs));
    heartbeatAt(services, "W-A", nowMs - workerHeartbeatStaleMs());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(count(services)).toBe(1);

    setSystemTime(new Date(nowMs + 1));
    expect(count(services)).toBe(0);
  });

  test("a live worker past the max-hold bound releases the slot", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    const sweptMs = Date.parse(SWEEP_TS);
    // The bound must outlast stdio-acp's 20-min idle timer, which a busy
    // session keeps re-arming and which never reports dispatch.end.
    services.clock = (): Date => new Date(sweptMs + 20 * 60_000 + 1);
    expect(count(services)).toBe(1);

    services.clock = (): Date => new Date(sweptMs + STALE_SWEEP_DRAIN_MAX_HOLD_MS + 1);
    expect(count(services)).toBe(0);
  });

  test("the draining query is driven by idx_dispatch_events_end_ts, then the handoffs PK", () => {
    const services = tempServices();

    const plan = services.db
      .query<{ detail: string }, (string | number)[]>(
        `EXPLAIN QUERY PLAN ${sweeperDrainingCountSql("?,?")}`,
      )
      .all(SWEEP_TS, ...SEATS, 0)
      .map((row) => row.detail);

    expect(plan[0]).toContain("USING INDEX idx_dispatch_events_end_ts");
    expect(plan[1]).toContain("(handoff_id=?)");
    expect(plan.join("\n")).not.toContain("SCAN");
  });

  test("only the sweeper's own dispatch.end row drives the hold", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    services.dispatchEventLog.record({
      handoff_id: "h-swept",
      worker_id: null,
      source: "daemon",
      kind: "dispatch.end",
      ts: SWEEP_TS,
    });

    expect(count(services)).toBe(1);
  });

  test("the hold survives a daemon restart (empty in-memory watchdog)", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", Date.now());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    services.watchdog = new WatchdogService(services, 90_000);

    expect(count(services)).toBe(1);
  });

  test("a revoked worker token is not live", () => {
    const services = tempServices();
    const store = new WorkerTokenStore(services.db);
    const { token_hash } = store.issue({ worker_id: "W-A" }, Date.now());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");
    expect(count(services)).toBe(1);

    store.revoke(token_hash, Date.now());
    expect(count(services)).toBe(0);
  });
});
