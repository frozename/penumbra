import type { DaemonClient } from "@src/daemon-client.js";

import { type TextContentEnvelope } from "@novaproto/mcp-shared";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { TOOL_REGISTRY } from "@src/tools/registry.js";
import { Database } from "bun:sqlite";
import { beforeAll, expect, it } from "bun:test";

import { listPendingDreamActionsQuery } from "../../../daemon/src/dreaming/digest.js";
import {
  approveCuratorPattern,
  disableCuratorPattern,
  insertCuratorPattern,
  queryCuratorPatterns,
} from "../../../daemon/src/routes/curator.js";

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

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function seedPattern(
  db: Database,
  opts: {
    pattern_id?: string;
    pattern: string;
    status: string;
    enabled?: number;
    reason?: string;
  },
): void {
  db.prepare(
    `INSERT INTO curator_ephemera_patterns (pattern_id, pattern, reason, status, proposed_by, proposed_at, enabled)
     VALUES (?, ?, ?, ?, 'test', ?, ?)`,
  ).run(
    opts.pattern_id ?? crypto.randomUUID(),
    opts.pattern,
    opts.reason ?? "test reason",
    opts.status,
    Date.now(),
    opts.enabled ?? 0,
  );
}

function seedDreamAction(db: Database, opts: { action_type: string; status: string }): void {
  const cycleId = "cycle-curator-test";
  const exists = db.prepare(`SELECT 1 FROM dream_cycles WHERE cycle_id = ?`).get(cycleId);
  if (!exists) {
    db.prepare(
      `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES(?, ?, 'cron', 1.0, 'completed', '[]')`,
    ).run(cycleId, Date.now());
  }
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
     VALUES(?, ?, 'P1', ?, 0.9, ?, '[]', '{}', 0)`,
  ).run(crypto.randomUUID(), cycleId, opts.action_type, opts.status);
}

type CuratorFakeDaemon = Pick<
  DaemonClient,
  | "getCuratorPatterns"
  | "postCuratorPatterns"
  | "postCuratorPatternApprove"
  | "postCuratorPatternDisable"
  | "listPendingDreamActions"
>;

async function callTool(toolName: string, args: unknown, db: Database): Promise<unknown> {
  const fakeDaemon: CuratorFakeDaemon = {
    getCuratorPatterns: (req) => Promise.resolve(queryCuratorPatterns(db, req)),
    postCuratorPatterns: (req) => Promise.resolve(insertCuratorPattern(db, req)),
    postCuratorPatternApprove: (req) => {
      const result = approveCuratorPattern(db, req.pattern_id);
      if (!result) throw new Error("not_found");
      return Promise.resolve(result);
    },
    postCuratorPatternDisable: (req) => {
      const result = disableCuratorPattern(db, req.pattern_id);
      if (!result) throw new Error("not_found");
      return Promise.resolve(result);
    },
    listPendingDreamActions: (req) => Promise.resolve(listPendingDreamActionsQuery(db, req)),
  };
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  const handler = tool.makeHandler(fakeDaemon as DaemonClient);
  const result = (await handler(args)) as TextContentEnvelope;
  return JSON.parse(result.content[0]!.text);
}

interface PatternsListResult {
  patterns: { pattern: string }[];
}

interface AddPatternResult {
  pattern_id: string;
}

interface PendingDreamActionsResult {
  actions: { action_type: string }[];
}

interface PatternRow {
  status: string;
  enabled: number;
}

it("memory_curator_patterns_list returns approved patterns", async () => {
  const db = openTestDb();
  seedPattern(db, { pattern: "URL: %", status: "approved", enabled: 1 });
  seedPattern(db, { pattern: "Other: %", status: "queued" });
  const result = (await callTool("memory_curator_patterns_list", {}, db)) as PatternsListResult;
  expect(result.patterns).toHaveLength(1);
  expect(result.patterns[0]?.pattern).toBe("URL: %");
});

it("memory_curator_patterns_list status=all returns every row", async () => {
  const db = openTestDb();
  seedPattern(db, { pattern: "A", status: "approved", enabled: 1 });
  seedPattern(db, { pattern: "B", status: "queued" });
  const result = (await callTool(
    "memory_curator_patterns_list",
    { status: "all" },
    db,
  )) as PatternsListResult;
  expect(result.patterns).toHaveLength(2);
});

it("memory_curator_patterns_add inserts queued pattern", async () => {
  const db = openTestDb();
  const r = (await callTool(
    "memory_curator_patterns_add",
    { pattern: "Recall context: %", reason: "recall preamble" },
    db,
  )) as AddPatternResult;
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id=?`)
    .get(r.pattern_id) as PatternRow;
  expect(row.status).toBe("queued");
  expect(row.enabled).toBe(0);
});

it("memory_curator_patterns_approve flips status + enabled", async () => {
  const db = openTestDb();
  seedPattern(db, { pattern_id: "p1", pattern: "test", status: "queued", enabled: 0 });
  await callTool("memory_curator_patterns_approve", { pattern_id: "p1" }, db);
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id='p1'`)
    .get() as PatternRow;
  expect(row.status).toBe("approved");
  expect(row.enabled).toBe(1);
});

it("memory_curator_patterns_disable sets enabled=0 without changing status", async () => {
  const db = openTestDb();
  seedPattern(db, { pattern_id: "p1", pattern: "test", status: "approved", enabled: 1 });
  await callTool("memory_curator_patterns_disable", { pattern_id: "p1" }, db);
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id='p1'`)
    .get() as PatternRow;
  expect(row.status).toBe("approved");
  expect(row.enabled).toBe(0);
});

it("memory_list_pending_dream_actions includes ephemera_retire + cluster_retire", async () => {
  const db = openTestDb();
  seedDreamAction(db, { action_type: "ephemera_retire", status: "queued" });
  seedDreamAction(db, { action_type: "cluster_retire", status: "queued" });
  const result = (await callTool(
    "memory_list_pending_dream_actions",
    {},
    db,
  )) as PendingDreamActionsResult;
  const types = result.actions.map((a) => a.action_type);
  expect(types).toContain("ephemera_retire");
  expect(types).toContain("cluster_retire");
});
