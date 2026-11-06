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
  createClaimSpreadReoffer,
  DEFAULT_SPREAD_STARVATION_SWEEPS,
} from "@src/services/claim-spread-reoffer.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const STARVATION_MSG = "claim spread re-offer: handoff re-offered repeatedly without a claim";
const FAILURE_MSG = "claim spread re-offer failed";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/claim-spread-reoffer-rules-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${String(++n)}`;
    })(),
  });
}

function setup(): { services: Services; emitted: HandoffRow[] } {
  const services = tempServices();
  services.log = {
    info: mock(),
    warn: mock(),
    debug: mock(),
    error: mock(),
  } as unknown as Services["log"];
  const emitted: HandoffRow[] = [];
  services.handoffEvents.subscribe((row) => emitted.push(row));
  return { services, emitted };
}

function seedHandoff(
  services: Services,
  handoff_id: string,
  workflow_run_id: string | null,
  tsOffsetMs = 0,
): void {
  services.handoffWriter.createApproved({
    handoff_id,
    ts: new Date(Date.parse("2026-05-21T10:00:00.000Z") + tsOffsetMs).toISOString(),
    project_id: null,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: "worker",
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
    dispatch_kind: workflow_run_id === null ? null : "workflow",
    workflow_run_id,
  });
}

function reofferEvents(services: Services, handoff_id: string): { meta_json: string | null }[] {
  return services.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id=? AND kind='claim.reoffer'")
    .all(handoff_id);
}

type WarnCall = [Record<string, unknown>, string];

function warnCalls(services: Services, message: string): WarnCall[] {
  const spy = services.log.warn as unknown as { mock: { calls: WarnCall[] } };
  return spy.mock.calls.filter((call) => call[1] === message);
}

test("row cap: sweep re-offers only the maxRowsPerReoffer oldest rows of a run", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "cap-1", "wfrun-cap", 0);
  seedHandoff(services, "cap-2", "wfrun-cap", 1);
  seedHandoff(services, "cap-3", "wfrun-cap", 2);
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services, maxRowsPerReoffer: 2 }).sweep();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    workflow_run_id: "wfrun-cap",
    waiting: 2,
    reoffered: ["cap-1", "cap-2"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["cap-1", "cap-2"]);
});

test("oldest first: reoffered and emitted order follow ts ASC", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "ord-20", "wfrun-ord", 20);
  seedHandoff(services, "ord-0", "wfrun-ord", 0);
  seedHandoff(services, "ord-10", "wfrun-ord", 10);
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    reoffered: ["ord-0", "ord-10", "ord-20"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["ord-0", "ord-10", "ord-20"]);
});

test("exhausted attempts: a sibling at max_dispatch_attempts is never re-offered", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "exh-1", "wfrun-exh", 0);
  seedHandoff(services, "exh-live", "wfrun-exh", 1);
  seedHandoff(services, "exh-only", "wfrun-exh-exhausted", 2);
  services.db
    .query<
      never,
      [string]
    >("UPDATE handoffs SET dispatch_attempts=max_dispatch_attempts WHERE handoff_id=?")
    .run("exh-1");
  services.db
    .query<
      never,
      [string]
    >("UPDATE handoffs SET dispatch_attempts=max_dispatch_attempts WHERE handoff_id=?")
    .run("exh-only");
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    workflow_run_id: "wfrun-exh",
    waiting: 1,
    reoffered: ["exh-live"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["exh-live"]);
  expect(reofferEvents(services, "exh-1")).toEqual([]);
  expect(reofferEvents(services, "exh-only")).toEqual([]);
});

test("redirected rows: a redirected sibling is re-offered by sweep", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "red-1", "wfrun-red", 0);
  services.db
    .query<never, [string]>("UPDATE handoffs SET status='redirected' WHERE handoff_id=?")
    .run("red-1");
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    workflow_run_id: "wfrun-red",
    reoffered: ["red-1"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["red-1"]);
});

test("multiple runs: sweep emits one summary per workflow_run_id", () => {
  const { services } = setup();
  seedHandoff(services, "multi-a", "wfrun-multi-a", 0);
  seedHandoff(services, "multi-b", "wfrun-multi-b", 1);

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toHaveLength(2);
  expect(outcomes.map((outcome) => outcome.workflow_run_id).sort()).toEqual([
    "wfrun-multi-a",
    "wfrun-multi-b",
  ]);
  for (const outcome of outcomes) {
    expect(outcome).toMatchObject({ cause: "sweep", freed_by: null });
  }
});

test("starvation threshold: warn fires on the Nth consecutive sweep, not before", () => {
  const { services } = setup();
  seedHandoff(services, "starve-1", "wfrun-starve", 0);
  const reoffer = createClaimSpreadReoffer({ services, starvationSweeps: 2 });

  reoffer.sweep();
  expect(warnCalls(services, STARVATION_MSG)).toHaveLength(0);

  reoffer.sweep();
  const calls = warnCalls(services, STARVATION_MSG);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toMatchObject({ handoff_id: "starve-1", consecutive_sweeps: 2 });
});

test("starvation reset: a claimed row restarts the consecutive-sweep counter", () => {
  const { services } = setup();
  seedHandoff(services, "reset-1", "wfrun-reset", 0);
  const reoffer = createClaimSpreadReoffer({ services, starvationSweeps: 2 });

  reoffer.sweep();
  services.db
    .query<never, [string]>("UPDATE handoffs SET status='dispatched' WHERE handoff_id=?")
    .run("reset-1");
  reoffer.sweep();
  services.db
    .query<never, [string]>("UPDATE handoffs SET status='approved' WHERE handoff_id=?")
    .run("reset-1");
  reoffer.sweep();

  expect(warnCalls(services, STARVATION_MSG)).toHaveLength(0);
});

test("default starvation: warn first fires on the 3rd consecutive sweep", () => {
  expect(DEFAULT_SPREAD_STARVATION_SWEEPS).toBe(3);
  const { services } = setup();
  seedHandoff(services, "default-1", "wfrun-default", 0);
  const reoffer = createClaimSpreadReoffer({ services });

  reoffer.sweep();
  reoffer.sweep();
  expect(warnCalls(services, STARVATION_MSG)).toHaveLength(0);

  reoffer.sweep();
  const calls = warnCalls(services, STARVATION_MSG);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toMatchObject({ handoff_id: "default-1", consecutive_sweeps: 3 });
});

test("unknown handoff: onLeftDispatched skips with not_workflow and emits nothing", () => {
  const { services, emitted } = setup();

  const outcome = createClaimSpreadReoffer({ services }).onLeftDispatched({
    kind: "left_dispatched",
    handoff_id: "missing",
    to_agent: "w",
    to_status: "completed",
    ts: "2026-05-21T10:00:00.000Z",
  });

  expect(outcome).toEqual({
    skipped: "not_workflow",
    workflow_run_id: null,
    cause: "left_dispatched",
  });
  expect(emitted).toEqual([]);
});

test("nothing waiting: onLeftDispatched skips when the run has no other waiting rows", () => {
  const { services } = setup();
  seedHandoff(services, "nw-1", "wfrun-nw", 0);
  expect(services.handoffWriter.claimDispatch("nw-1", "W-A")).toBe(true);

  const outcome = createClaimSpreadReoffer({ services }).onLeftDispatched({
    kind: "left_dispatched",
    handoff_id: "nw-1",
    to_agent: "W-A",
    to_status: "completed",
    ts: "2026-05-21T10:00:00.000Z",
  });

  expect(outcome).toEqual({
    skipped: "nothing_waiting",
    workflow_run_id: "wfrun-nw",
    cause: "left_dispatched",
  });
});

test("freed-by meta: onLeftDispatched stamps cause and freed_by on the sibling event", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "fb-1", "wfrun-fb", 0);
  seedHandoff(services, "fb-2", "wfrun-fb", 1);
  expect(services.handoffWriter.claimDispatch("fb-1", "W-A")).toBe(true);
  emitted.length = 0;

  const outcome = createClaimSpreadReoffer({ services }).onLeftDispatched({
    kind: "left_dispatched",
    handoff_id: "fb-1",
    to_agent: "W-A",
    to_status: "completed",
    ts: "2026-05-21T10:00:00.000Z",
  });

  expect(outcome).toMatchObject({
    workflow_run_id: "wfrun-fb",
    cause: "left_dispatched",
    freed_by: "fb-1",
    waiting: 1,
    reoffered: ["fb-2"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["fb-2"]);
  const events = reofferEvents(services, "fb-2");
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]?.meta_json ?? "{}")).toMatchObject({
    cause: "workflow_spread:left_dispatched",
    workflow_run_id: "wfrun-fb",
    freed_by: "fb-1",
    waiting: 1,
  });
});

test("error path: a throwing dispatchEventLog yields an error outcome and no emits", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "err-1", "wfrun-err", 0);
  services.dispatchEventLog = {
    record: () => {
      throw new Error("boom");
    },
  } as unknown as Services["dispatchEventLog"];
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toEqual([
    {
      skipped: "error",
      workflow_run_id: "wfrun-err",
      cause: "sweep",
      err: "Error: boom",
    },
  ]);
  expect(warnCalls(services, FAILURE_MSG)).toHaveLength(1);
  expect(emitted).toEqual([]);
});

test("idempotent start: subscribing twice still writes exactly one claim.reoffer event", () => {
  const { services } = setup();
  seedHandoff(services, "idem-1", "wfrun-idem", 0);
  seedHandoff(services, "idem-2", "wfrun-idem", 1);
  expect(services.handoffWriter.claimDispatch("idem-1", "W-A")).toBe(true);

  const reactor = createClaimSpreadReoffer({ services });
  reactor.start();
  reactor.start();
  expect(services.handoffWriter.markCompleted("idem-1", { expected_worker_id: "W-A" })).toBe(true);
  reactor.stop();

  expect(reofferEvents(services, "idem-2")).toHaveLength(1);
});

test("stop unsubscribes: completing a sibling after stop writes no claim.reoffer event", () => {
  const { services } = setup();
  seedHandoff(services, "stop-1", "wfrun-stop", 0);
  seedHandoff(services, "stop-2", "wfrun-stop", 1);
  expect(services.handoffWriter.claimDispatch("stop-1", "W-A")).toBe(true);

  const reactor = createClaimSpreadReoffer({ services });
  reactor.start();
  reactor.stop();
  expect(services.handoffWriter.markCompleted("stop-1", { expected_worker_id: "W-A" })).toBe(true);

  expect(reofferEvents(services, "stop-2")).toEqual([]);
});

test("tick sweeps: awaiting tick re-offers a stranded sibling once", async () => {
  const { services, emitted } = setup();
  seedHandoff(services, "tick-1", "wfrun-tick", 0);
  emitted.length = 0;

  await createClaimSpreadReoffer({ services }).tick();

  expect(emitted.map((row) => row.handoff_id)).toEqual(["tick-1"]);
  expect(reofferEvents(services, "tick-1")).toHaveLength(1);
});
