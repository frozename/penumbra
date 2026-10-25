import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import {
  countProviderInFlight,
  listCappedProviders,
  listProviderQuotaStatus,
  type ProviderConcurrencyDecision,
  recordProviderCapRefusal,
  releaseSweptDrainHolds,
  resolveProviderConcurrencyDecision,
  resolveProviderSeatNames,
  STALE_SWEEP_DRAIN_MAX_HOLD_MS,
  sweeperDrainingCountSql,
  SWEPT_DRAIN_RELEASE_CANDIDATES_SQL,
} from "@src/services/provider-concurrency.js";
import { WatchdogService } from "@src/services/watchdog.js";
import { workerHeartbeatStaleMs } from "@src/worker-heartbeat-stale.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

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

test("listProviderQuotaStatus reports provider-wide caps with live in-flight counts", () => {
  const services = tempServices();
  configureProviderCap(services, 2);
  services.providerQuotas = [...services.providerQuotas, { provider: "openai" }];
  seedApprovedHandoff(services, "h-quota-1", { to: "claude-a" });
  expect(services.handoffWriter.claimDispatch("h-quota-1", "W-A")).toBe(true);

  expect(listProviderQuotaStatus(services)).toEqual([
    { provider: "anthropic", max_in_flight: 2, in_flight: 1 },
  ]);
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
const CLOCK_MS = Date.parse("2026-05-21T10:00:00.000Z");
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
    heartbeatAt(services, "W-A", CLOCK_MS - workerHeartbeatStaleMs() - 60_000);

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(count(services)).toBe(0);
  });

  test("the worker stale bound is inclusive and moves with the injected clock", () => {
    const services = tempServices();
    heartbeatAt(services, "W-A", CLOCK_MS - workerHeartbeatStaleMs());

    claimed(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(count(services)).toBe(1);

    services.clock = (): Date => new Date(CLOCK_MS + 1);
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

// The restarted incarnation of W-A boots at BOOT_TS (its claimed_before) and heartbeats
// under the same worker_id when it reconciles at RECONCILE_MS. The previous incarnation
// claimed its sessions at PREVIOUS_CLAIM_TS.
const BOOT_TS = "2026-05-21T10:04:00.000Z";
const RECONCILE_MS = Date.parse("2026-05-21T10:05:00.000Z");
const PREVIOUS_CLAIM_TS = "2026-05-21T09:50:00.000Z";

function restartedWorkerServices(): Services {
  const services = tempServices();
  services.clock = (): Date => new Date(RECONCILE_MS);
  heartbeatAt(services, "W-A", RECONCILE_MS);
  heartbeatAt(services, "W-B", RECONCILE_MS);
  return services;
}

// claimDispatch stamps last_dispatch_started_at with the wall clock, which the release
// compares against claimed_before.
function stampClaim(services: Services, handoff_id: string, ts: string | null): void {
  services.db
    .query<
      never,
      [string | null, string]
    >("UPDATE handoffs SET last_dispatch_started_at=? WHERE handoff_id=?")
    .run(ts, handoff_id);
}

function claimedBeforeBoot(
  services: Services,
  handoff_id: string,
  to = "claude-a",
  tsOffsetMs = 0,
): void {
  claimed(services, handoff_id, to, tsOffsetMs);
  stampClaim(services, handoff_id, PREVIOUS_CLAIM_TS);
}

function drainReleases(
  services: Services,
  handoff_id: string,
): ReturnType<Services["dispatchEventLog"]["listByHandoff"]> {
  return services.dispatchEventLog
    .listByHandoff(handoff_id)
    .filter((event) => event.kind === "worker.recovery.drain_released");
}

describe("releaseSweptDrainHolds at worker boot reconcile (#236)", () => {
  test("a reconcile with claimed_before after the claim releases the previous incarnation's hold", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");
    expect(count(services)).toBe(1);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual(["h-swept"]);

    expect(count(services)).toBe(0);
    const released = drainReleases(services, "h-swept");
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      worker_id: "W-A",
      source: "daemon",
      ts: new Date(RECONCILE_MS).toISOString(),
    });
    expect(JSON.parse(released[0]?.meta_json ?? "null")).toEqual({ claimed_before: BOOT_TS });
    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual([]);
    expect(drainReleases(services, "h-swept")).toHaveLength(1);
  });

  test("a session claimed before claimed_before but swept after it is released", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-swept-after-boot");
    sweepLikeStaleSweeper(services, "h-swept-after-boot", "2026-05-21T10:04:30.000Z");
    expect(count(services)).toBe(1);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual(["h-swept-after-boot"]);

    expect(count(services)).toBe(0);
    expect(drainReleases(services, "h-swept-after-boot")).toHaveLength(1);
  });

  test("a session claimed at or after claimed_before stays held even when swept", () => {
    const services = restartedWorkerServices();
    claimed(services, "h-claimed-at-boot");
    stampClaim(services, "h-claimed-at-boot", BOOT_TS);
    sweepLikeStaleSweeper(services, "h-claimed-at-boot", "2026-05-21T10:04:20.000Z");
    claimed(services, "h-claimed-after-boot", "claude-a", 1);
    stampClaim(services, "h-claimed-after-boot", "2026-05-21T10:04:10.000Z");
    sweepLikeStaleSweeper(services, "h-claimed-after-boot", "2026-05-21T10:04:30.000Z");
    expect(count(services)).toBe(2);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual([]);

    expect(count(services)).toBe(2);
    expect(drainReleases(services, "h-claimed-at-boot")).toEqual([]);
    expect(drainReleases(services, "h-claimed-after-boot")).toEqual([]);
  });

  test("a session with no recorded claim time is released, as orphan recovery treats it", () => {
    const services = restartedWorkerServices();
    claimed(services, "h-unstamped");
    stampClaim(services, "h-unstamped", null);
    sweepLikeStaleSweeper(services, "h-unstamped");

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual(["h-unstamped"]);

    expect(count(services)).toBe(0);
    expect(drainReleases(services, "h-unstamped")).toHaveLength(1);
  });

  test("a reconcile from another worker or with claimed_before not after the claim keeps the hold", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");

    expect(releaseSweptDrainHolds(services, "W-B", BOOT_TS)).toEqual([]);
    expect(releaseSweptDrainHolds(services, "W-A", PREVIOUS_CLAIM_TS)).toEqual([]);
    expect(releaseSweptDrainHolds(services, "W-A", "2026-05-21T09:49:59.999Z")).toEqual([]);

    expect(count(services)).toBe(1);
    expect(drainReleases(services, "h-swept")).toEqual([]);
  });

  test("an offset claimed_before releases the same rows as its Z form and records the Z form", () => {
    const releaseWith = (claimedBefore: string): { released: string[]; meta: unknown } => {
      const services = restartedWorkerServices();
      claimedBeforeBoot(services, "h-swept");
      sweepLikeStaleSweeper(services, "h-swept");
      claimed(services, "h-claimed-at-boot", "claude-a", 1);
      stampClaim(services, "h-claimed-at-boot", BOOT_TS);
      sweepLikeStaleSweeper(services, "h-claimed-at-boot", "2026-05-21T10:04:20.000Z");
      const released = releaseSweptDrainHolds(services, "W-A", claimedBefore);
      return {
        released,
        meta: JSON.parse(drainReleases(services, "h-swept")[0]?.meta_json ?? "null"),
      };
    };

    const zForm = releaseWith(BOOT_TS);

    expect(zForm).toEqual({ released: ["h-swept"], meta: { claimed_before: BOOT_TS } });
    expect(releaseWith("2026-05-21T06:04:00-04:00")).toEqual(zForm);
  });

  test("a reconcile keeps live dispatches and other workers' drain holds counted", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");
    seedApprovedHandoff(services, "h-peer-swept", { to: "claude-b", tsOffsetMs: 1 });
    expect(services.handoffWriter.claimDispatch("h-peer-swept", "W-B")).toBe(true);
    stampClaim(services, "h-peer-swept", PREVIOUS_CLAIM_TS);
    sweepLikeStaleSweeper(services, "h-peer-swept");
    claimedBeforeBoot(services, "h-live", "claude-b", 2);
    expect(count(services)).toBe(3);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual(["h-swept"]);

    expect(count(services)).toBe(2);
    expect(services.handoffReader.get("h-live")).toMatchObject({
      status: "dispatched",
      worker_id: "W-A",
    });
    expect(drainReleases(services, "h-peer-swept")).toEqual([]);
    expect(drainReleases(services, "h-live")).toEqual([]);
  });

  test("a reconcile releases only handoffs the sweeper itself left draining", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-ended");
    sweepLikeStaleSweeper(services, "h-ended");
    recordWorkerEvent(services, "h-ended", "dispatch.end");
    claimedBeforeBoot(services, "h-cancel", "claude-a", 1);
    expect(
      services.handoffWriter.markFailed("h-cancel", {
        reason: "cancelled",
        resolved_by: "cancel",
        ts: SWEEP_TS,
      }),
    ).toBe(true);
    insertSweeperDispatchEnd(services, "h-cancel");
    claimedBeforeBoot(services, "h-not-failed", "claude-a", 2);
    services.db
      .query<
        never,
        []
      >("UPDATE handoffs SET resolved_by='stale-handoff-sweeper' WHERE handoff_id='h-not-failed'")
      .run();
    insertSweeperDispatchEnd(services, "h-not-failed");
    // Force-failed as if by the sweeper, but its only dispatch.end is daemon-sourced.
    claimedBeforeBoot(services, "h-daemon-end", "claude-a", 3);
    services.dispatchEventLog.record({
      handoff_id: "h-daemon-end",
      worker_id: null,
      source: "daemon",
      kind: "dispatch.end",
      ts: SWEEP_TS,
    });
    expect(
      services.handoffWriter.markFailed("h-daemon-end", {
        reason: "stale_force_resolve",
        resolved_by: "stale-handoff-sweeper",
        ts: SWEEP_TS,
      }),
    ).toBe(true);
    expect(count(services)).toBe(1);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual([]);

    expect(count(services)).toBe(1);
    for (const handoff_id of ["h-ended", "h-cancel", "h-not-failed", "h-daemon-end"]) {
      expect(drainReleases(services, handoff_id)).toEqual([]);
    }
  });

  test("a release past the max-hold bound records nothing", () => {
    const services = restartedWorkerServices();
    claimedBeforeBoot(services, "h-swept");
    sweepLikeStaleSweeper(services, "h-swept");
    services.clock = (): Date => new Date(CLOCK_MS + STALE_SWEEP_DRAIN_MAX_HOLD_MS + 1);
    heartbeatAt(services, "W-A", CLOCK_MS + STALE_SWEEP_DRAIN_MAX_HOLD_MS + 1);

    expect(releaseSweptDrainHolds(services, "W-A", BOOT_TS)).toEqual([]);
    expect(drainReleases(services, "h-swept")).toEqual([]);
  });

  test("the release query is driven by idx_dispatch_events_end_ts, then the handoffs PK", () => {
    const services = tempServices();

    const plan = services.db
      .query<{ detail: string }, string[]>(
        `EXPLAIN QUERY PLAN ${SWEPT_DRAIN_RELEASE_CANDIDATES_SQL}`,
      )
      .all(SWEEP_TS, BOOT_TS, "W-A")
      .map((row) => row.detail);

    expect(plan[0]).toContain("USING INDEX idx_dispatch_events_end_ts");
    expect(plan[1]).toContain("(handoff_id=?)");
    expect(plan.join("\n")).not.toContain("SCAN");
  });
});
