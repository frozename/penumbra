import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { WorkflowFn } from "../../src/index.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

// Load the workflow fn straight from source — the daemon discovers it the same way
// (plugin/workflows/<name>/workflow.ts), so this exercises the shipped artifact.
const mod = (await import("../../../../plugin/workflows/dispatch-drift-guard/workflow.ts")) as {
  fn: WorkflowFn<{ db?: Database; session_id?: string }>;
};
const fn = mod.fn;

const MAESTRO_SESSION = "0a1b2c3d-1111-2222-3333-444455556666";

let db: Database;
let seq = 0;

function makeDb(): Database {
  const d = new Database(":memory:");
  loadSqliteVec(d);
  migrate(d, { embeddingDim: 384 });
  return d;
}

// Seed an agent-tool-use row exactly as the PreToolUse hook writes it
// (event_type='agent-tool-use', source='claude-code', payload_json.tool=NAME,
// source_detail='tool:NAME'). seq drives a monotonic ts so ORDER BY ts DESC is stable.
function seedTool(sessionId: string, toolName: string): void {
  seq += 1;
  const idx = String(seq).padStart(2, "0");
  const ts = `2026-06-15T00:00:${idx}Z`;
  db.prepare(
    `INSERT INTO t0_events (
       event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
       session_id, event_type, lane, payload_json, payload_summary, origin
     ) VALUES (?, ?, ?, 'claude-code', ?, 'penumbra', 'claude-code', 'local',
       ?, 'agent-tool-use', 'cli-subscription', ?, ?, 'maestro')`,
  ).run(
    `e${String(seq)}`,
    ts,
    ts,
    `tool:${toolName}`,
    sessionId,
    JSON.stringify({ tool: toolName, input: {} }),
    `${toolName}(...)`,
  );
}

type DriftCtx = {
  config: Record<string, never>;
  cwd: string;
  storageRoot: string;
  project: string;
  args: { session_id?: string };
  db: () => Database;
  dispatch: () => Promise<{ conversation_id: string; handoff_id: string }>;
  awaitChain: () => Promise<{
    status: "timeout";
    final_agent: null;
    response_text: null;
  }>;
  fileWrite: () => Promise<string>;
};

function ctx(args: { session_id?: string }): DriftCtx {
  return {
    config: {},
    cwd: "/tmp",
    storageRoot: "/tmp",
    project: "penumbra",
    args,
    db: () => db,
    dispatch: () => Promise.resolve({ conversation_id: "c", handoff_id: "h" }),
    awaitChain: () =>
      Promise.resolve({
        status: "timeout" as const,
        final_agent: null,
        response_text: null,
      }),
    fileWrite: () => Promise.resolve("/tmp/out"),
  };
}

const emptyBundle: Parameters<typeof fn>[1] = {
  byKey: {},
  warnings: [],
  estimatedTokens: 0,
};

async function run(args: { session_id?: string }): Promise<string> {
  const out = await fn(ctx(args), emptyBundle);
  return typeof out === "string" ? out : "";
}

// The guard no longer detects ultracode (uniform threshold; the ultracode-conditional
// lives in the reminder text + global instruction the model applies), so the only env
// knobs are the threshold, the re-nag cadence, and the kill switch.
const ENV_KEYS = [
  "PENUMBRA_SOLO_DRIFT_THRESHOLD",
  "PENUMBRA_SOLO_DRIFT_RENAG",
  "PENUMBRA_DISPATCH_DRIFT_ENABLED",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  db = makeDb();
  seq = 0;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
});

afterEach(() => {
  db.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      Reflect.deleteProperty(process.env, k);
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// below the (default 8) threshold -> silent
test("below threshold stays silent", async () => {
  for (let i = 0; i < 7; i++) seedTool(MAESTRO_SESSION, "Edit");
  expect(await run({ session_id: MAESTRO_SESSION })).toBe("");
});

// at threshold -> fires; the single reminder carries the ultracode conditional for the
// model to apply (it is the party that knows whether ultracode is on).
test("at threshold fires, with the ultracode conditional in the reminder text", async () => {
  for (let i = 0; i < 8; i++) seedTool(MAESTRO_SESSION, "Edit");
  const out = await run({ session_id: MAESTRO_SESSION });
  expect(out).toContain("dispatch-drift:");
  expect(out).toContain("workflow_run");
  expect(out).toContain("ultracode is ON"); // conditional guidance, applied by the model
  expect(out).toContain("SOLO-OK");
});

// MCP fs tools count as solo
test("MCP fs/shell tools count toward the streak", async () => {
  for (let i = 0; i < 4; i++) seedTool(MAESTRO_SESSION, "mcp__penumbra__fs_edit");
  for (let i = 0; i < 4; i++) seedTool(MAESTRO_SESSION, "mcp__penumbra__shell_run");
  expect(await run({ session_id: MAESTRO_SESSION })).toContain("dispatch-drift:");
});

// reads/greps and status polls neither increment nor reset
test("reads and status polls do not increment or reset the streak", async () => {
  for (let i = 0; i < 4; i++) seedTool(MAESTRO_SESSION, "Edit");
  seedTool(MAESTRO_SESSION, "Read");
  seedTool(MAESTRO_SESSION, "Grep");
  seedTool(MAESTRO_SESSION, "mcp__penumbra__chain_status"); // poll, NOT a dispatch
  for (let i = 0; i < 4; i++) seedTool(MAESTRO_SESSION, "Edit");
  // 8 edits with inert rows interleaved => streak 8 => fires
  expect(await run({ session_id: MAESTRO_SESSION })).toContain("dispatch-drift:");
});

// a real dispatch resets the streak
test("a real dispatch resets the streak", async () => {
  for (let i = 0; i < 10; i++) seedTool(MAESTRO_SESSION, "Edit");
  seedTool(MAESTRO_SESSION, "mcp__penumbra__chain_start"); // dispatch -> reset
  for (let i = 0; i < 3; i++) seedTool(MAESTRO_SESSION, "Edit");
  // trailing streak is 3 (< 8) -> silent
  expect(await run({ session_id: MAESTRO_SESSION })).toBe("");
});

test("mcp workflow_run and CC Task both reset the streak", async () => {
  for (let i = 0; i < 9; i++) seedTool(MAESTRO_SESSION, "Edit");
  seedTool(MAESTRO_SESSION, "mcp__penumbra__workflow_run"); // dispatch -> reset
  for (let i = 0; i < 3; i++) seedTool(MAESTRO_SESSION, "Edit");
  seedTool(MAESTRO_SESSION, "Task"); // dispatch -> reset
  for (let i = 0; i < 2; i++) seedTool(MAESTRO_SESSION, "Edit");
  // trailing streak is 2 (< 8) -> silent
  expect(await run({ session_id: MAESTRO_SESSION })).toBe("");
});

// threshold env knob lowers the bar
test("PENUMBRA_SOLO_DRIFT_THRESHOLD lowers the bar", async () => {
  process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD = "3";
  for (let i = 0; i < 3; i++) seedTool(MAESTRO_SESSION, "Edit");
  expect(await run({ session_id: MAESTRO_SESSION })).toContain("dispatch-drift:");
});

// best-effort: a throwing ctx.db returns "" (never breaks Claude Code)
test("a throwing ctx.db returns empty, not a throw", async () => {
  const throwingCtx = {
    ...ctx({ session_id: MAESTRO_SESSION }),
    db: (): Database => {
      throw new Error("db open failed");
    },
  };
  const out = await fn(throwingCtx, emptyBundle);
  expect(typeof out === "string" ? out : "").toBe("");
});

// re-nag cadence: fires at threshold, silent at +1..+3, fires again at +renag
test("re-nag cadence fires at threshold then every renag calls", async () => {
  // default threshold 8, renag 4
  const fireCounts: number[] = [];
  for (let n = 1; n <= 16; n++) {
    db.close();
    db = makeDb();
    seq = 0;
    for (let i = 0; i < n; i++) seedTool(MAESTRO_SESSION, "Edit");
    if ((await run({ session_id: MAESTRO_SESSION })) !== "") fireCounts.push(n);
  }
  // fires at 8 (=threshold), 12 (+4), 16 (+8); silent at 9,10,11,13,14,15
  expect(fireCounts).toEqual([8, 12, 16]);
});

// origin guard: dispatch-worker sessions and missing session_id stay silent
test("non-maestro sessions stay silent", async () => {
  for (let i = 0; i < 12; i++) seedTool("conv-abc", "Edit");
  expect(await run({ session_id: "conv-abc" })).toBe("");
  expect(await run({})).toBe("");
  for (let i = 0; i < 12; i++) seedTool("not-a-uuid", "Edit");
  expect(await run({ session_id: "not-a-uuid" })).toBe("");
});

// kill switch
test("PENUMBRA_DISPATCH_DRIFT_ENABLED=0 disables the guard", async () => {
  process.env.PENUMBRA_DISPATCH_DRIFT_ENABLED = "0";
  for (let i = 0; i < 12; i++) seedTool(MAESTRO_SESSION, "Edit");
  expect(await run({ session_id: MAESTRO_SESSION })).toBe("");
});
