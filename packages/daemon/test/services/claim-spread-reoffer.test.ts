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
import { readFileSync } from "node:fs";

import { createClaimSpreadReoffer } from "@src/services/claim-spread-reoffer.js";

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
    storageRoot: "/tmp/claim-spread-reoffer-test",
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

test("sweep re-offers a stranded workflow sibling over handoffEvents", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "sib-1", "wfrun-1", 0);
  seedHandoff(services, "sib-2", "wfrun-1", 1);
  expect(services.handoffWriter.claimDispatch("sib-1", "W-A")).toBe(true);
  emitted.length = 0;

  const outcomes = createClaimSpreadReoffer({ services }).sweep();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    workflow_run_id: "wfrun-1",
    cause: "sweep",
    freed_by: null,
    waiting: 1,
    reoffered: ["sib-2"],
  });
  expect(emitted.map((row) => row.handoff_id)).toEqual(["sib-2"]);
  const events = reofferEvents(services, "sib-2");
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]?.meta_json ?? "{}")).toMatchObject({
    cause: "workflow_spread:sweep",
    workflow_run_id: "wfrun-1",
  });
});

test("sweep ignores rows that carry no workflow_run_id", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "plain-1", null, 0);
  emitted.length = 0;

  expect(createClaimSpreadReoffer({ services }).sweep()).toEqual([]);
  expect(emitted).toEqual([]);
  expect(reofferEvents(services, "plain-1")).toEqual([]);
});

test("a completed workflow sibling immediately re-offers the run's waiting siblings", () => {
  const { services, emitted } = setup();
  seedHandoff(services, "sib-a", "wfrun-2", 0);
  seedHandoff(services, "sib-b", "wfrun-2", 1);
  expect(services.handoffWriter.claimDispatch("sib-a", "W-A")).toBe(true);
  emitted.length = 0;

  const reactor = createClaimSpreadReoffer({ services });
  reactor.start();
  expect(services.handoffWriter.markCompleted("sib-a", { expected_worker_id: "W-A" })).toBe(true);
  reactor.stop();

  expect(emitted.map((row) => row.handoff_id)).toContain("sib-b");
  expect(reofferEvents(services, "sib-b")).toHaveLength(1);
});

test("serve.ts wires the claim-spread re-offer sweeper onto the supervisor", () => {
  const serveSrc = readFileSync(new URL("../../src/serve.ts", import.meta.url), "utf8");
  expect(serveSrc).toContain("createClaimSpreadReoffer(");
  expect(serveSrc).toContain('name: "claim-spread-reoffer"');
  expect(serveSrc).toContain("CLAIM_SPREAD_REOFFER_SWEEP_INTERVAL_MS");
});
