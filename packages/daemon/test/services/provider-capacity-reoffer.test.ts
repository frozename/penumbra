import {
  buildServices,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import {
  createProviderCapacityReoffer,
  type ReofferOutcome,
  type ReofferServices,
  type ReofferSummary,
} from "@src/services/provider-capacity-reoffer.js";

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
    storageRoot: "/tmp/provider-capacity-reoffer-test",
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

function seedApprovedHandoff(
  services: Services,
  handoff_id: string,
  opts: { to?: string; tsOffsetMs?: number } = {},
): void {
  const ts = new Date(
    Date.parse("2026-05-21T10:00:00.000Z") + (opts.tsOffsetMs ?? 0),
  ).toISOString();
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

function setup(): { services: Services; emitted: HandoffRow[]; log: Services["log"] } {
  const services = tempServices();
  configureProviderCap(services, 1);
  const log = { info: mock(), warn: mock(), debug: mock(), error: mock() };
  services.log = log as unknown as Services["log"];
  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));
  return { services, emitted, log: services.log };
}

function claimReofferRows(services: Services, handoff_id: string): { meta_json: string | null }[] {
  return services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .all(handoff_id);
}

function expectSummary(outcome: ReofferOutcome): ReofferSummary {
  if ("skipped" in outcome) throw new Error(`expected summary, got ${outcome.skipped}`);
  return outcome;
}

test("onLeftDispatched returns skipped:no_cap and emits nothing when no provider-wide cap is configured", () => {
  const { services, emitted } = setup();
  services.providerQuotas = [];
  const reactor = createProviderCapacityReoffer({ services });

  expect(
    reactor.onLeftDispatched({
      kind: "left_dispatched",
      handoff_id: "h",
      to_agent: "claude-a",
      to_status: "completed",
      ts: "2026-05-21T10:00:00.000Z",
    }),
  ).toEqual({ skipped: "no_cap", provider: null, cause: "left_dispatched" });
  expect(emitted).toEqual([]);
  const stub = { providerQuotas: undefined } as unknown as ReofferServices;
  expect(createProviderCapacityReoffer({ services: stub }).sweep()).toEqual([]);
});

test("a completed dispatch re-offers the oldest waiting row for the same provider over handoffEvents", () => {
  const { services, emitted, log } = setup();
  seedApprovedHandoff(services, "running", { to: "claude-a" });
  seedApprovedHandoff(services, "waiting", { to: "claude-b", tsOffsetMs: 1 });
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  emitted.length = 0;
  const reactor = createProviderCapacityReoffer({ services });
  reactor.start();

  expect(services.handoffWriter.markCompleted("running", { expected_worker_id: "W-A" })).toBe(true);

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.handoff_id).toBe("waiting");
  expect(emitted[0]?.status).toBe("approved");
  const rows = claimReofferRows(services, "waiting");
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]?.meta_json ?? "{}")).toMatchObject({
    cause: "left_dispatched",
    freed_by: "running",
    to_status: "completed",
  });
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "anthropic",
      cause: "left_dispatched",
      freed_by: "running",
      to_status: "completed",
      max_in_flight: 1,
      in_flight_count: 0,
      free: 1,
      waiting: 1,
      reoffered: ["waiting"],
    }),
    "provider capacity re-offer",
  );
});

test("onLeftDispatched returns skipped:still_at_cap, emits nothing, and still logs the info line while the provider is at cap", () => {
  const { services, emitted, log } = setup();
  configureProviderCap(services, 2);
  seedApprovedHandoff(services, "running-a", { to: "claude-a" });
  seedApprovedHandoff(services, "running-b", { to: "claude-b" });
  expect(services.handoffWriter.claimDispatch("running-a", "W-A")).toBe(true);
  expect(services.handoffWriter.claimDispatch("running-b", "W-B")).toBe(true);
  emitted.length = 0;
  configureProviderCap(services, 1);
  const reactor = createProviderCapacityReoffer({ services });

  const outcome = reactor.onLeftDispatched({
    kind: "left_dispatched",
    handoff_id: "x",
    to_agent: "claude-a",
    to_status: "completed",
    ts: "2026-05-21T10:00:00.000Z",
  });

  expect(outcome).toMatchObject({ skipped: "still_at_cap", provider: "anthropic" });
  expect(emitted).toEqual([]);
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ reoffered: [] }),
    "provider capacity re-offer",
  );
});

test("onLeftDispatched returns skipped:nothing_waiting and still logs the info heartbeat", () => {
  const { services, emitted, log } = setup();
  const reactor = createProviderCapacityReoffer({ services });

  const outcome = reactor.onLeftDispatched({
    kind: "left_dispatched",
    handoff_id: "running",
    to_agent: "claude-a",
    to_status: "completed",
    ts: "2026-05-21T10:00:00.000Z",
  });

  expect(outcome).toMatchObject({ skipped: "nothing_waiting", provider: "anthropic" });
  expect(emitted).toEqual([]);
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ waiting: 0, reoffered: [] }),
    "provider capacity re-offer",
  );
});

test("re-offer limit is min(free + 1, maxRowsPerReoffer), oldest first", () => {
  const { services, emitted } = setup();
  seedApprovedHandoff(services, "w0", { to: "claude-a" });
  seedApprovedHandoff(services, "w1", { to: "claude-b", tsOffsetMs: 1 });
  seedApprovedHandoff(services, "w2", { to: "claude-a", tsOffsetMs: 2 });
  emitted.length = 0;

  const summary = expectSummary(createProviderCapacityReoffer({ services }).sweep()[0]);
  expect(summary.reoffered).toEqual(["w0", "w1"]);
  expect(emitted.map((row) => row.handoff_id)).toEqual(["w0", "w1"]);

  emitted.length = 0;
  const limited = expectSummary(
    createProviderCapacityReoffer({ services, maxRowsPerReoffer: 1 }).sweep()[0],
  );
  expect(limited.reoffered).toEqual(["w0"]);
  expect(emitted.map((row) => row.handoff_id)).toEqual(["w0"]);
});

test("sweep() re-offers waiting rows for every capped provider and ignores uncapped ones", () => {
  const { services, emitted } = setup();
  const agents = services.agentchatConfig?.agents;
  if (!agents) throw new Error("missing test agents");
  agents.push({
    name: "gemini",
    roles: [],
    adapter: "stdio-acp",
    pricing_mode: "subscription",
    subscription_provider: "google",
  });
  seedApprovedHandoff(services, "anthropic-waiting", { to: "claude-b" });
  seedApprovedHandoff(services, "google-waiting", { to: "gemini", tsOffsetMs: 1 });
  emitted.length = 0;

  const outcomes = createProviderCapacityReoffer({ services, maxRowsPerReoffer: 1 }).sweep();

  expect(outcomes).toHaveLength(1);
  const summary = expectSummary(outcomes[0]);
  expect(summary).toMatchObject({
    provider: "anthropic",
    cause: "sweep",
    freed_by: null,
    reoffered: ["anthropic-waiting"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["anthropic-waiting"]);
  expect(
    JSON.parse(claimReofferRows(services, "anthropic-waiting")[0]?.meta_json ?? "{}"),
  ).toMatchObject({
    cause: "sweep",
  });
});

test("a throwing handoffEvents.emit cannot break the writer transition", () => {
  const { services, log } = setup();
  seedApprovedHandoff(services, "running", { to: "claude-a" });
  seedApprovedHandoff(services, "waiting", { to: "claude-b", tsOffsetMs: 1 });
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  services.handoffEvents.emit = (): never => {
    throw new Error("boom");
  };
  const reactor = createProviderCapacityReoffer({ services });
  reactor.start();

  expect(services.handoffWriter.markCompleted("running", { expected_worker_id: "W-A" })).toBe(true);
  expect(services.handoffReader.get("running")?.status).toBe("completed");
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "anthropic", cause: "left_dispatched" }),
    "provider capacity re-offer failed",
  );
  expect(
    reactor.onLeftDispatched({
      kind: "left_dispatched",
      handoff_id: "running",
      to_agent: "claude-a",
      to_status: "completed",
      ts: "2026-05-21T10:00:00.000Z",
    }),
  ).toMatchObject({ skipped: "error", provider: "anthropic" });
});

test("starvation tripwire warns after N consecutive sweeps re-offering the same handoff", () => {
  const { services, log } = setup();
  seedApprovedHandoff(services, "waiting", { to: "claude-b" });
  const reactor = createProviderCapacityReoffer({ services, starvationSweeps: 2 });

  reactor.sweep();
  reactor.sweep();

  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "anthropic",
      handoff_id: "waiting",
      consecutive_sweeps: 2,
    }),
    "provider capacity re-offer: handoff re-offered repeatedly without a claim",
  );
  const warnCount = mock(log.warn).mock.calls.length;
  expect(services.handoffWriter.claimDispatch("waiting", "W-B")).toBe(true);
  reactor.sweep();
  expect(mock(log.warn).mock.calls.length).toBe(warnCount);
});

test("stop() unsubscribes: transitions after stop emit nothing", () => {
  const { services, emitted } = setup();
  seedApprovedHandoff(services, "running", { to: "claude-a" });
  seedApprovedHandoff(services, "waiting", { to: "claude-b", tsOffsetMs: 1 });
  expect(services.handoffWriter.claimDispatch("running", "W-A")).toBe(true);
  emitted.length = 0;
  const reactor = createProviderCapacityReoffer({ services });
  reactor.start();
  reactor.stop();

  expect(services.handoffWriter.markCompleted("running", { expected_worker_id: "W-A" })).toBe(true);

  expect(emitted).toEqual([]);
});

test("tick() resolves and performs one sweep", async () => {
  const { services, emitted } = setup();
  seedApprovedHandoff(services, "waiting", { to: "claude-b" });
  emitted.length = 0;
  const reactor = createProviderCapacityReoffer({ services, maxRowsPerReoffer: 1 });

  await reactor.tick();

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.handoff_id).toBe("waiting");
});

test("sweep() warns when a capped provider resolves to no seats", () => {
  const { services, emitted, log } = setup();
  services.providerQuotas = [{ provider: "ghost", max_in_flight: 2 }];

  const outcomes = createProviderCapacityReoffer({ services }).sweep();

  expect(outcomes).toEqual([{ skipped: "no_cap", provider: "ghost", cause: "sweep" }]);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "ghost", max_in_flight: 2 }),
    "provider capacity re-offer: capped provider has no seats",
  );
  expect(emitted).toEqual([]);
});
