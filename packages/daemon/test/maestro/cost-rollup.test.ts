import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { rollupCostForChain } from "@src/maestro/cost-rollup.js";

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertHandoff(db: Database, handoffId: string, parentHandoffId: string | null): void {
  db.query<
    unknown,
    [string, string, string, string, string, string, string, string | null, string | null]
  >(
    `INSERT INTO handoffs (
      handoff_id, ts, conversation_id, from_agent, to_agent, message, status, project_id, parent_handoff_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoffId,
    "2026-05-05T00:00:00.000Z",
    "conv-1",
    "maestro",
    "worker",
    "do work",
    "dispatched",
    null,
    parentHandoffId,
  );
}

interface InsertEventInput {
  eventId: string;
  handoffId?: string | null;
  eventType?: string;
  provider?: string | null;
  model?: string | null;
  costUsd: number | null;
}

function insertEvent(db: Database, opts: InsertEventInput): void {
  const eventType = opts.eventType ?? "usage-update";
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? "claude-sonnet";
  const handoffId = opts.handoffId ?? null;
  db.query<
    unknown,
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      number | null,
      string,
    ]
  >(
    `INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model,
      cost_usd, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.eventId,
    "2026-05-05T00:00:00.000Z",
    "2026-05-05T00:00:00.000Z",
    "agentchat",
    "u",
    "m",
    eventType,
    "cli-subscription",
    provider,
    model,
    opts.costUsd,
    JSON.stringify(handoffId === null ? { used: 1 } : { handoff_id: handoffId, used: 1 }),
  );
}

let db: Database;

beforeEach(() => {
  db = setupDb();
});

describe("rollupCostForChain", () => {
  test("returns 0 for an unknown chain id and for a handoff with no usage events", () => {
    expect(rollupCostForChain(db, "h-missing")).toBe(0);
    insertHandoff(db, "h-empty", null);
    expect(rollupCostForChain(db, "h-empty")).toBe(0);
  });

  test("counts cumulative usage-update events once at their maximum", () => {
    insertHandoff(db, "h-max", null);
    insertEvent(db, { eventId: "u-max-1", handoffId: "h-max", costUsd: 0.1 });
    insertEvent(db, { eventId: "u-max-2", handoffId: "h-max", costUsd: 0.3 });
    insertEvent(db, { eventId: "u-max-3", handoffId: "h-max", costUsd: 0.2 });
    expect(rollupCostForChain(db, "h-max")).toBe(30);
  });

  test("sums distinct models on the same handoff", () => {
    insertHandoff(db, "h-models", null);
    insertEvent(db, {
      eventId: "u-models-sonnet",
      handoffId: "h-models",
      model: "claude-sonnet",
      costUsd: 0.25,
    });
    insertEvent(db, {
      eventId: "u-models-opus",
      handoffId: "h-models",
      model: "claude-opus",
      costUsd: 0.5,
    });
    expect(rollupCostForChain(db, "h-models")).toBe(75);
  });

  test("sums the same model under distinct providers", () => {
    insertHandoff(db, "h-providers", null);
    insertEvent(db, {
      eventId: "u-prov-anthropic",
      handoffId: "h-providers",
      provider: "anthropic",
      model: "claude-sonnet",
      costUsd: 0.1,
    });
    insertEvent(db, {
      eventId: "u-prov-bedrock",
      handoffId: "h-providers",
      provider: "bedrock",
      model: "claude-sonnet",
      costUsd: 0.2,
    });
    expect(rollupCostForChain(db, "h-providers")).toBe(30);
  });

  test("ignores usage-final and tool-call events", () => {
    insertHandoff(db, "h-types", null);
    insertEvent(db, { eventId: "u-types-update", handoffId: "h-types", costUsd: 0.3 });
    insertEvent(db, {
      eventId: "u-types-final",
      handoffId: "h-types",
      eventType: "usage-final",
      costUsd: 9.99,
    });
    insertEvent(db, {
      eventId: "u-types-tool",
      handoffId: "h-types",
      eventType: "tool-call",
      costUsd: 9.99,
    });
    expect(rollupCostForChain(db, "h-types")).toBe(30);
  });

  test("excludes events without a handoff_id and events for unrelated handoffs", () => {
    insertHandoff(db, "h-scope", null);
    insertEvent(db, { eventId: "u-scope-in", handoffId: "h-scope", costUsd: 0.2 });
    insertEvent(db, { eventId: "u-scope-orphan", handoffId: null, costUsd: 5 });
    insertHandoff(db, "h-scope-unrelated", null);
    insertEvent(db, { eventId: "u-scope-unrelated", handoffId: "h-scope-unrelated", costUsd: 7 });
    expect(rollupCostForChain(db, "h-scope")).toBe(20);
  });

  test("rolls up a branching handoff tree and scopes each subtree", () => {
    insertHandoff(db, "R", null);
    insertHandoff(db, "A", "R");
    insertHandoff(db, "B", "R");
    insertHandoff(db, "C", "A");
    insertEvent(db, { eventId: "u-R", handoffId: "R", costUsd: 0.01 });
    insertEvent(db, { eventId: "u-A", handoffId: "A", costUsd: 0.02 });
    insertEvent(db, { eventId: "u-B", handoffId: "B", costUsd: 0.04 });
    insertEvent(db, { eventId: "u-C", handoffId: "C", costUsd: 0.08 });

    expect(rollupCostForChain(db, "R")).toBe(15);
    expect(rollupCostForChain(db, "A")).toBe(10);
    expect(rollupCostForChain(db, "C")).toBe(8);
  });

  test("rounds once on the summed dollars across sibling groups", () => {
    insertHandoff(db, "root-sum-round", null);
    insertHandoff(db, "child-sum-round-1", "root-sum-round");
    insertHandoff(db, "child-sum-round-2", "root-sum-round");
    insertEvent(db, { eventId: "u-sum-round-1", handoffId: "child-sum-round-1", costUsd: 0.006 });
    insertEvent(db, { eventId: "u-sum-round-2", handoffId: "child-sum-round-2", costUsd: 0.006 });
    expect(rollupCostForChain(db, "root-sum-round")).toBe(1);
  });

  test("rounds a lone fractional cost up to the nearest cent", () => {
    insertHandoff(db, "root-lone-round", null);
    insertEvent(db, { eventId: "u-lone-round", handoffId: "root-lone-round", costUsd: 0.019 });
    expect(rollupCostForChain(db, "root-lone-round")).toBe(2);
  });

  test("ignores NULL cost events", () => {
    insertHandoff(db, "h-null-only", null);
    insertEvent(db, { eventId: "u-null-only", handoffId: "h-null-only", costUsd: null });
    expect(rollupCostForChain(db, "h-null-only")).toBe(0);

    insertHandoff(db, "h-null-mixed", null);
    insertEvent(db, { eventId: "u-null-mixed-null", handoffId: "h-null-mixed", costUsd: null });
    insertEvent(db, { eventId: "u-null-mixed-40", handoffId: "h-null-mixed", costUsd: 0.4 });
    expect(rollupCostForChain(db, "h-null-mixed")).toBe(40);
  });
});
