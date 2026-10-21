import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import {
  countProviderInFlight,
  listCappedProviders,
  type ProviderConcurrencyDecision,
  recordProviderCapRefusal,
  resolveProviderConcurrencyDecision,
  resolveProviderSeatNames,
  STALE_SWEEP_DRAIN_GRACE_MS,
} from "@src/services/provider-concurrency.js";

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

describe("countProviderInFlight stale-sweep drain hold (#218)", () => {
  test("(a) holds slot after sweeper force-resolve until worker dispatch.end arrives", () => {
    const services = tempServices();
    configureProviderCap(services, 1);
    const count = (seats: string[]): number => countProviderInFlight(services, seats);

    seedApprovedHandoff(services, "h-swept", { to: "claude-a" });
    services.handoffWriter.claimDispatch("h-swept", "W-A");
    expect(count(["claude-a", "claude-b"])).toBe(1);

    services.handoffWriter.markFailed("h-swept", {
      reason: "stale_force_resolve",
      resolved_by: "stale-handoff-sweeper",
      ts: "2026-05-21T10:00:00.000Z",
    });
    expect(count(["claude-a", "claude-b"])).toBe(1);

    services.db.run(
      `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, NULL, 'sweeper', 'dispatch.end', ?, NULL)`,
      ["h-swept", "2026-05-21T10:00:01.000Z"],
    );
    expect(count(["claude-a", "claude-b"])).toBe(1);

    services.dispatchEventLog.record({
      handoff_id: "h-swept",
      worker_id: "W-A",
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-05-21T10:00:05.000Z",
    });
    expect(count(["claude-a", "claude-b"])).toBe(0);
  });

  test("(b) releases slot when resolved_at falls outside the drain grace window", () => {
    const services = tempServices();
    configureProviderCap(services, 1);
    const count = (seats: string[]): number => countProviderInFlight(services, seats);

    seedApprovedHandoff(services, "h-swept", { to: "claude-a" });
    services.handoffWriter.claimDispatch("h-swept", "W-A");
    expect(count(["claude-a", "claude-b"])).toBe(1);

    const staleTs = new Date(
      Date.parse("2026-05-21T10:00:00.000Z") - STALE_SWEEP_DRAIN_GRACE_MS - 1000,
    ).toISOString();
    services.handoffWriter.markFailed("h-swept", {
      reason: "stale_force_resolve",
      resolved_by: "stale-handoff-sweeper",
      ts: staleTs,
    });
    expect(count(["claude-a", "claude-b"])).toBe(0);
  });

  test("(c) does not hold slot for non-sweeper resolved_by values", () => {
    const services = tempServices();
    configureProviderCap(services, 1);
    const count = (seats: string[]): number => countProviderInFlight(services, seats);

    seedApprovedHandoff(services, "h-fail", { to: "claude-a" });
    services.handoffWriter.claimDispatch("h-fail", "W-A");
    services.handoffWriter.markFailed("h-fail", {
      reason: "dispatch error",
      ts: "2026-05-21T10:00:00.000Z",
    });

    seedApprovedHandoff(services, "h-cancel", { to: "claude-a", tsOffsetMs: 1 });
    services.handoffWriter.claimDispatch("h-cancel", "W-A");
    services.handoffWriter.markFailed("h-cancel", {
      reason: "cancelled",
      resolved_by: "cancel",
      ts: "2026-05-21T10:00:00.000Z",
    });

    expect(count(["claude-a", "claude-b"])).toBe(0);
  });
});
