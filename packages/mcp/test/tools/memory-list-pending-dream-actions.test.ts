import type {
  ListPendingDreamActionsOpts,
  ListPendingDreamActionsResult,
} from "@penumbra/daemon/dreaming/digest";

import { applySchema, loadSqliteVec } from "@penumbra/core";
import { listPendingDreamActionsQuery } from "@penumbra/daemon/dreaming/digest";
import { Database } from "bun:sqlite";
import { beforeAll, expect, it } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { memoryListPendingDreamActionsHandler } from "@src/tools/memory-list-pending-dream-actions.js";
import { TOOL_REGISTRY } from "@src/tools/registry.js";

import { fakeDaemon } from "../helpers.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

type ListPendingDreamActionsFn = DaemonClient["listPendingDreamActions"];

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function seedCycle(db: Database, cycleId: string): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', 1.0, 'completed', '[]')`,
  ).run(cycleId, Date.now());
}

function appendDreamAction(
  db: Database,
  opts: {
    cycleId?: string;
    phase: string;
    actionType: string;
    status: string;
    confidence: number;
    targetIds: string[];
    payload: object;
    untrustedSource: number;
  },
): void {
  const cycleId = opts.cycleId ?? "cycle-default";
  const exists = db.prepare(`SELECT 1 FROM dream_cycles WHERE cycle_id = ?`).get(cycleId);
  if (!exists) seedCycle(db, cycleId);

  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    cycleId,
    opts.phase,
    opts.actionType,
    opts.confidence,
    opts.status,
    JSON.stringify(opts.targetIds),
    JSON.stringify(opts.payload),
    opts.untrustedSource,
  );
}

async function callMemoryListPending(
  args: unknown,
  db: Database,
): Promise<ListPendingDreamActionsResult> {
  const listPendingDreamActions: ListPendingDreamActionsFn = (req: {
    limit?: number;
  }): Promise<ListPendingDreamActionsResult> => {
    const opts: ListPendingDreamActionsOpts = {};
    if (req.limit !== undefined) opts.limit = req.limit;
    return Promise.resolve(listPendingDreamActionsQuery(db, opts));
  };
  const handler = memoryListPendingDreamActionsHandler(fakeDaemon({ listPendingDreamActions }));
  const result = await handler(args);
  const block = result.content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return JSON.parse(block.text) as ListPendingDreamActionsResult;
}

it("tool name is memory_list_pending_dream_actions (not dream_pending_actions)", () => {
  const names = Object.keys(TOOL_REGISTRY);
  expect(names).toContain("memory_list_pending_dream_actions");
  expect(names).not.toContain("dream_pending_actions");
});

it("returns queued actions with untrusted_source and oldest_pending_age_hours", async () => {
  const db = openTestDb();
  appendDreamAction(db, {
    phase: "P3",
    actionType: "rewrite",
    status: "queued",
    confidence: 0.7,
    targetIds: ["m1"],
    payload: {},
    untrustedSource: 0,
  });
  appendDreamAction(db, {
    phase: "P5",
    actionType: "mint_research",
    status: "queued",
    confidence: 0.6,
    targetIds: ["m2"],
    payload: {},
    untrustedSource: 1,
  });
  const result = await callMemoryListPending({ limit: 10 }, db);
  expect(result.actions).toHaveLength(2);
  const research = result.actions.find((a) => a.action_type === "mint_research");
  expect(research?.untrusted_source).toBe(1);
  expect(result.oldest_pending_age_hours).toBeGreaterThanOrEqual(0);
});

it("does NOT return auto_applied or rejected actions", async () => {
  const db = openTestDb();
  appendDreamAction(db, {
    phase: "P2",
    actionType: "link",
    status: "auto_applied",
    confidence: 0.9,
    targetIds: ["m1"],
    payload: {},
    untrustedSource: 0,
  });
  const result = await callMemoryListPending({}, db);
  expect(result.actions).toHaveLength(0);
});
