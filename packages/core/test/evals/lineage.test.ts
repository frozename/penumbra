import { Database } from "bun:sqlite";
import { afterEach, beforeAll, expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { AssistanceSchema, LineageSchema, LineageUsageSchema } from "@src/evals/manifest.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

// Input and output shapes are declared locally: lineage.ts does not exist at
// the base, so no value or type may be imported from it.
type LineageRow = {
  handoff_id: string;
  ts: string;
  message: string;
  parent_handoff_id: string | null;
  triggered_by_event_id: string | null;
  branch_base: string | null;
  branch_name: string | null;
  workflow_run_id: string | null;
};

type AssistanceEntry = { kind: string; attempt_n: number; ref: string | null };

type BuiltLineage = {
  root_handoff_id: string | null;
  handoff_ids: string[];
  shape: "single" | "chain" | "branching" | "fixture";
  assistance: AssistanceEntry[];
  labels: Record<string, string>;
};

type HelperEntry = { handoff_id: string; kind: string };

type BuildLineagesResult = { lineages: BuiltLineage[]; helpers: HelperEntry[] };

type BuildLineagesFn = (
  rows: readonly LineageRow[],
  retryEvents?: ReadonlyMap<string, string>,
) => BuildLineagesResult | Promise<BuildLineagesResult>;

type HelperInput = {
  branch_name: string | null;
  branch_base: string | null;
  message: string;
};

type LineageUsage = {
  tokens: number | null;
  cost_usd: number | null;
  handoff_ids_counted: number;
  complete: boolean;
  incomplete_reason: "t0_retention_window" | "handoff_usage_missing" | null;
};

type LineageUsageFn = (
  db: Database,
  scope: { handoff_ids: readonly string[]; start_ts: string },
  opts: { now: number; t0RetentionDays: number },
) => LineageUsage | null | Promise<LineageUsage | null>;

type TaskRefs = { issues: number[]; bundle_ids: string[] };

const MOD_URL = new URL("../../src/evals/lineage.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const NOW = Date.parse("2026-11-03T00:00:00Z");

const T1 = "2026-11-02T00:00:00Z";
const T2 = "2026-11-02T01:00:00Z";
const T3 = "2026-11-02T02:00:00Z";
const T4 = "2026-11-02T03:00:00Z";

const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);

const RETRY_MSG = "[silent-failure-retry] retry_of=A prior_agent=x\n\nbody";
const RETRY_ORPHAN_MSG = "[silent-failure-retry] retry_of=Z prior_agent=x\n\nbody";
const CHECK_MARKER_MSG =
  "You are an independent CHECK verifier in a separate fleet worktree. Do not edit, commit, push, or land anything.\n\nRun the CHECK verbatim.";
const RUBRIC_MARKER_MSG =
  "You are an independent rubric grader in a separate worktree based on the exact candidate branch. Refute unsupported claims. Do not edit, dispatch, land, push, or alter branches.";

type RowInit = { handoff_id: string; ts: string } & Partial<Omit<LineageRow, "handoff_id" | "ts">>;

function row(init: RowInit): LineageRow {
  return {
    message: "task",
    parent_handoff_id: null,
    triggered_by_event_id: null,
    branch_base: null,
    branch_name: null,
    workflow_run_id: null,
    ...init,
  };
}

function lineageByRoot(result: BuildLineagesResult, rootId: string): BuiltLineage | undefined {
  return result.lineages.find((lin) => lin.root_handoff_id === rootId);
}

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function insertUsageUpdate(db: Database, eventId: string, payloadJson: string): void {
  db.prepare(
    `INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
     VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'p', 'm', ?, ?)`,
  ).run(eventId, "2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z", null, payloadJson);
}

test("parseRetryOf reads a first-line retry stamp and rejects later or absent stamps", () => {
  const fn = mod?.["parseRetryOf"];
  expect(typeof fn).toBe("function");
  const parse = fn as (message: string) => string | null;
  expect(parse(RETRY_MSG)).toBe("A");
  expect(parse(`lead-in\n${RETRY_MSG}`)).toBeNull();
  expect(parse("Investigate queue backlog")).toBeNull();
});

test("stripRetryStamp removes the stamp line and its blank separator", () => {
  const fn = mod?.["stripRetryStamp"];
  expect(typeof fn).toBe("function");
  const strip = fn as (message: string) => string;
  expect(strip(RETRY_MSG)).toBe("body");
  expect(strip("Investigate queue backlog")).toBe("Investigate queue backlog");
});

test("classifyHelper names a verify-check branch a check verifier", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(
    classify({
      branch_name: "review/verify-check_1a2b3c4d",
      branch_base: "main",
      message: "x",
    }),
  ).toBe("helper_check_verifier");
});

test("classifyHelper names a rubric-grade branch a rubric grader", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(
    classify({
      branch_name: "task/rubric-grade_5e6f7a8b",
      branch_base: "main",
      message: "x",
    }),
  ).toBe("helper_rubric_grader");
});

test("classifyHelper does not treat a SHA branch_base alone as helper evidence", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(classify({ branch_name: "agent/r1", branch_base: SHA_C, message: "x" })).toBeNull();
});

test("classifyHelper marks a renamed SHA-based row via the CHECK marker", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(
    classify({ branch_name: "review/x_9", branch_base: SHA_C, message: CHECK_MARKER_MSG }),
  ).toBe("helper_check_verifier");
});

test("classifyHelper marks a SHA-based row via the rubric grader marker", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(
    classify({ branch_name: "review/x_9", branch_base: SHA_C, message: RUBRIC_MARKER_MSG }),
  ).toBe("helper_rubric_grader");
});

test("classifyHelper ignores the CHECK marker when the base is a branch name", () => {
  const fn = mod?.["classifyHelper"];
  expect(typeof fn).toBe("function");
  const classify = fn as (input: HelperInput) => string | null;
  expect(
    classify({ branch_name: "review/x_9", branch_base: "main", message: CHECK_MARKER_MSG }),
  ).toBeNull();
});

test("buildLineages joins a retry child to its parent's lineage", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build(
    [
      row({ handoff_id: "A", ts: T1 }),
      row({
        handoff_id: "B",
        ts: T2,
        parent_handoff_id: "A",
        triggered_by_event_id: "e1",
      }),
    ],
    new Map([["e1", "A"]]),
  );
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("A");
  expect(lin.handoff_ids).toEqual(["A", "B"]);
  expect(lin.shape).toBe("chain");
  expect(lin.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "A" }]);
  expect(lin.labels).toEqual({});
  for (const entry of lin.assistance) {
    expect(AssistanceSchema.safeParse(entry).success).toBe(true);
  }
  expect(
    LineageSchema.safeParse({
      root_handoff_id: lin.root_handoff_id,
      handoff_ids: lin.handoff_ids,
      shape: lin.shape,
    }).success,
  ).toBe(true);
});

test("buildLineages marks a parent hop without retry evidence as a chain hop", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build(
    [
      row({ handoff_id: "A", ts: T1 }),
      row({
        handoff_id: "B",
        ts: T2,
        parent_handoff_id: "A",
        triggered_by_event_id: "e1",
      }),
    ],
    new Map(),
  );
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.handoff_ids).toEqual(["A", "B"]);
  expect(lin.shape).toBe("chain");
  expect(lin.assistance).toEqual([{ kind: "chain_hop", attempt_n: 2, ref: "A" }]);
});

test("buildLineages links a stamped retry message to the stamped parent", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T1 }),
    row({ handoff_id: "B", ts: T2, message: RETRY_MSG }),
  ]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("A");
  expect(lin.handoff_ids).toEqual(["A", "B"]);
  expect(lin.shape).toBe("chain");
  expect(lin.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "A" }]);
  expect(lin.labels["retry_link_conflict"]).toBeUndefined();
});

test("buildLineages does not label an event-agrees-with-stamp retry as a conflict", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build(
    [
      row({ handoff_id: "A", ts: T1 }),
      row({ handoff_id: "B", ts: T2, message: RETRY_MSG, triggered_by_event_id: "eB" }),
    ],
    new Map([["eB", "A"]]),
  );
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("A");
  expect(lin.handoff_ids).toEqual(["A", "B"]);
  expect(lin.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "A" }]);
  expect(lin.labels["retry_link_conflict"]).toBeUndefined();
});

test("buildLineages prefers the message stamp over a conflicting event-mapped parent", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build(
    [
      row({ handoff_id: "A", ts: T1 }),
      row({ handoff_id: "B", ts: T2, message: RETRY_MSG, triggered_by_event_id: "eB" }),
      row({ handoff_id: "C", ts: T3 }),
    ],
    new Map([["eB", "C"]]),
  );
  expect(result.lineages).toHaveLength(2);
  const lineageA = lineageByRoot(result, "A");
  expect(lineageA?.handoff_ids).toEqual(["A", "B"]);
  expect(lineageA?.labels["retry_link_conflict"]).toBe("true");
  expect(lineageA?.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "A" }]);
  const lineageC = lineageByRoot(result, "C");
  expect(lineageC?.handoff_ids).toEqual(["C"]);
  expect(lineageC?.shape).toBe("single");
  expect(lineageC?.labels["retry_link_conflict"]).toBeUndefined();
});

test("buildLineages labels a parent_handoff_id that disagrees with the retry stamp", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T1 }),
    row({ handoff_id: "B", ts: T2, message: RETRY_MSG, parent_handoff_id: "D" }),
    row({ handoff_id: "C", ts: T3 }),
    row({ handoff_id: "D", ts: T4 }),
  ]);
  expect(result.lineages).toHaveLength(3);
  const lineageD = lineageByRoot(result, "D");
  expect(lineageD?.handoff_ids).toEqual(["D", "B"]);
  expect(lineageD?.shape).toBe("chain");
  expect(lineageD?.labels["retry_link_conflict"]).toBe("true");
  expect(lineageD?.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "D" }]);
  expect(lineageByRoot(result, "A")?.handoff_ids).toEqual(["A"]);
  expect(lineageByRoot(result, "A")?.labels["retry_link_conflict"]).toBeUndefined();
});

test("buildLineages labels a parent_handoff_id that disagrees with the event-mapped target", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build(
    [
      row({ handoff_id: "A", ts: T1 }),
      row({
        handoff_id: "B",
        ts: T2,
        parent_handoff_id: "D",
        triggered_by_event_id: "eB",
      }),
      row({ handoff_id: "D", ts: T4 }),
    ],
    new Map([["eB", "A"]]),
  );
  expect(result.lineages).toHaveLength(2);
  const lineageD = lineageByRoot(result, "D");
  expect(lineageD?.handoff_ids).toEqual(["D", "B"]);
  expect(lineageD?.labels["retry_link_conflict"]).toBe("true");
  expect(lineageD?.assistance).toEqual([{ kind: "retry_child", attempt_n: 2, ref: "D" }]);
  expect(lineageByRoot(result, "A")?.handoff_ids).toEqual(["A"]);
});

test("buildLineages records a retry to a missing parent on the child's own lineage", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([row({ handoff_id: "B", ts: T2, message: RETRY_ORPHAN_MSG })]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("B");
  expect(lin.handoff_ids).toEqual(["B"]);
  expect(lin.shape).toBe("single");
  expect(lin.assistance).toEqual([{ kind: "retry_child", attempt_n: 1, ref: "Z" }]);
  expect(lin.labels["retry_link_conflict"]).toBeUndefined();
});

test("buildLineages chains a later dispatch that builds on the prior branch", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a" }),
  ]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("A");
  expect(lin.handoff_ids).toEqual(["A", "B"]);
  expect(lin.shape).toBe("chain");
  expect(lin.assistance).toEqual([{ kind: "fix_round", attempt_n: 2, ref: "A" }]);
});

test("buildLineages still returns both rows when parent_handoff_ids form a two-cycle", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "C", ts: T1, parent_handoff_id: "D" }),
    row({ handoff_id: "D", ts: T2, parent_handoff_id: "C" }),
  ]);
  expect(result.lineages).toHaveLength(2);
  expect(lineageByRoot(result, "C")?.handoff_ids).toEqual(["C"]);
  expect(lineageByRoot(result, "D")?.handoff_ids).toEqual(["D"]);
});

test("buildLineages breaks a parent cycle before successor linking so descendant checks terminate", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "C", ts: T1, parent_handoff_id: "D", branch_name: "agent/c" }),
    row({ handoff_id: "D", ts: T2, parent_handoff_id: "C", branch_name: "agent/d" }),
    row({ handoff_id: "E", ts: T3, branch_base: "agent/d" }),
  ]);
  expect(result.lineages).toHaveLength(2);
  const lineageC = lineageByRoot(result, "C");
  expect(lineageC?.handoff_ids).toEqual(["C"]);
  expect(lineageC?.shape).toBe("single");
  const lineageD = lineageByRoot(result, "D");
  expect(lineageD?.handoff_ids).toEqual(["D", "E"]);
  expect(lineageD?.shape).toBe("chain");
  expect(lineageD?.assistance).toEqual([{ kind: "fix_round", attempt_n: 2, ref: "D" }]);
}, 2000);

test("buildLineages still returns all rows when parent and successor links form a mixed cycle", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "Y1", ts: T1, parent_handoff_id: "X2", branch_name: "agent/y1" }),
    row({ handoff_id: "Y2", ts: T2, parent_handoff_id: "X1", branch_name: "agent/y2" }),
    row({ handoff_id: "X1", ts: T3, branch_base: "agent/y1" }),
    row({ handoff_id: "X2", ts: T4, branch_base: "agent/y2" }),
  ]);
  const present = new Set(result.lineages.flatMap((lin) => lin.handoff_ids));
  expect(present.has("X1")).toBe(true);
  expect(present.has("X2")).toBe(true);
  expect(present.has("Y1")).toBe(true);
  expect(present.has("Y2")).toBe(true);
  expect(result.lineages).toHaveLength(4);
});

test("buildLineages keeps an orphan-stamped retry as a seeded root instead of a fix round", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T2, message: RETRY_ORPHAN_MSG, branch_base: "agent/a" }),
  ]);
  expect(result.lineages).toHaveLength(2);
  const linA = lineageByRoot(result, "A");
  expect(linA?.handoff_ids).toEqual(["A"]);
  expect(linA?.shape).toBe("single");
  const linB = lineageByRoot(result, "B");
  expect(linB?.handoff_ids).toEqual(["B"]);
  expect(linB?.shape).toBe("single");
  expect(linB?.assistance).toEqual([{ kind: "retry_child", attempt_n: 1, ref: "Z" }]);
  expect(linB?.assistance.some((entry) => entry.kind === "fix_round")).toBe(false);
});

test("buildLineages picks the nearest predecessor when two producers share one branch_name", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({
      handoff_id: "P1",
      ts: T1,
      branch_name: "agent/a",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
    row({
      handoff_id: "P2",
      ts: T2,
      branch_name: "agent/a",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
    row({ handoff_id: "C", ts: T3, branch_base: "agent/a", workflow_run_id: "w1" }),
  ]);
  expect(result.lineages).toHaveLength(2);
  const lineageP2 = lineageByRoot(result, "P2");
  expect(lineageP2?.handoff_ids).toEqual(["P2", "C"]);
  expect(lineageP2?.shape).toBe("chain");
  expect(lineageP2?.assistance).toEqual([{ kind: "fix_round", attempt_n: 2, ref: "P2" }]);
  const lineageP1 = lineageByRoot(result, "P1");
  expect(lineageP1?.handoff_ids).toEqual(["P1"]);
  expect(lineageP1?.shape).toBe("single");
});

test("buildLineages does not chain a branch_base link when producer and consumer share a ts", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "P", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "C", ts: T1, branch_base: "agent/a" }),
  ]);
  expect(result.lineages).toHaveLength(2);
  expect(lineageByRoot(result, "P")?.handoff_ids).toEqual(["P"]);
  expect(lineageByRoot(result, "C")?.handoff_ids).toEqual(["C"]);
});

test("buildLineages rejects a successor link that would close a loop", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "P", ts: T1, parent_handoff_id: "C", branch_name: "agent/x" }),
    row({ handoff_id: "C", ts: T2, branch_base: "agent/x" }),
  ]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("C");
  expect(lin.handoff_ids).toEqual(["C", "P"]);
  expect(lin.shape).toBe("chain");
});

test("buildLineages ignores a branch_base link when the child predates the parent", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T2, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T1, branch_base: "agent/a" }),
  ]);
  expect(result.lineages).toHaveLength(2);
});

test("buildLineages does not chain branch_base links across workflow runs", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const crossRun = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a", workflow_run_id: "w1" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a", workflow_run_id: "w2" }),
  ]);
  expect(crossRun.lineages).toHaveLength(2);
  const nullParent = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a", workflow_run_id: "w1" }),
  ]);
  expect(nullParent.lineages).toHaveLength(1);
  const nullChild = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a", workflow_run_id: "w1" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a" }),
  ]);
  expect(nullChild.lineages).toHaveLength(1);
});

test("buildLineages keeps same-run siblings on a shared base as separate singles", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({
      handoff_id: "S1",
      ts: T1,
      branch_name: "agent/s1",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
    row({
      handoff_id: "S2",
      ts: T2,
      branch_name: "agent/s2",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
  ]);
  expect(result.lineages).toHaveLength(2);
  const lineageS1 = lineageByRoot(result, "S1");
  const lineageS2 = lineageByRoot(result, "S2");
  expect(lineageS1?.handoff_ids).toEqual(["S1"]);
  expect(lineageS1?.shape).toBe("single");
  expect(lineageS2?.handoff_ids).toEqual(["S2"]);
  expect(lineageS2?.shape).toBe("single");
});

test("buildLineages marks a root with two branch_base children as branching", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a" }),
    row({ handoff_id: "C", ts: T3, branch_base: "agent/a" }),
  ]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("A");
  expect(lin.handoff_ids).toEqual(["A", "B", "C"]);
  expect(lin.shape).toBe("branching");
});

test("buildLineages pulls verifier and grader helpers out of the candidate lineage", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const result = await build([
    row({
      handoff_id: "R",
      ts: T1,
      branch_name: "agent/r1",
      branch_base: SHA_C,
      message: "implement the fix",
    }),
    row({
      handoff_id: "V1",
      ts: T2,
      branch_name: "review/verify-check_1a2b3c4d",
      branch_base: SHA_D,
    }),
    row({ handoff_id: "G", ts: T3, branch_name: "task/rubric-grade_5e6f7a8b" }),
    row({
      handoff_id: "V2",
      ts: T4,
      branch_name: "review/x_9",
      branch_base: SHA_E,
      message: CHECK_MARKER_MSG,
    }),
  ]);
  expect(result.lineages).toHaveLength(1);
  const lin = result.lineages[0]!;
  expect(lin.root_handoff_id).toBe("R");
  expect(lin.handoff_ids).toEqual(["R"]);
  expect(lin.shape).toBe("single");
  expect(result.helpers).toEqual([
    { handoff_id: "G", kind: "helper_rubric_grader" },
    { handoff_id: "V1", kind: "helper_check_verifier" },
    { handoff_id: "V2", kind: "helper_check_verifier" },
  ]);
});

test("buildLineages output is independent of input row order", async () => {
  const fn = mod?.["buildLineages"];
  expect(typeof fn).toBe("function");
  const build = fn as BuildLineagesFn;
  const rows = [
    row({ handoff_id: "A", ts: T1, branch_name: "agent/a" }),
    row({ handoff_id: "B", ts: T2, branch_base: "agent/a" }),
    row({ handoff_id: "C", ts: T3, branch_base: "agent/a" }),
    row({
      handoff_id: "S1",
      ts: T1,
      branch_name: "agent/s1",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
    row({
      handoff_id: "S2",
      ts: T2,
      branch_name: "agent/s2",
      branch_base: "main",
      workflow_run_id: "w1",
    }),
  ];
  const forward = await build(rows);
  const backward = await build([...rows].reverse());
  expect(backward).toEqual(forward);
});

test("lineageUsage sums usage-update tokens across the lineage handoffs", async () => {
  const fn = mod?.["lineageUsage"];
  expect(typeof fn).toBe("function");
  const usage = fn as LineageUsageFn;
  const db = freshDb();
  insertUsageUpdate(db, "u-a", JSON.stringify({ handoff_id: "A", used: 100 }));
  insertUsageUpdate(db, "u-b", JSON.stringify({ handoff_id: "B", used: 50 }));
  const result = await usage(
    db,
    { handoff_ids: ["A", "B"], start_ts: "2026-11-02T00:00:00Z" },
    { now: NOW, t0RetentionDays: 30 },
  );
  expect(result?.tokens).toBe(150);
  expect(result?.handoff_ids_counted).toBe(2);
  expect(result?.complete).toBe(true);
  expect(result?.incomplete_reason).toBeNull();
  expect(LineageUsageSchema.safeParse(result).success).toBe(true);
});

test("lineageUsage reports handoff_usage_missing when a member has no usage rows", async () => {
  const fn = mod?.["lineageUsage"];
  expect(typeof fn).toBe("function");
  const usage = fn as LineageUsageFn;
  const db = freshDb();
  insertUsageUpdate(db, "u-a", JSON.stringify({ handoff_id: "A", used: 100 }));
  const result = await usage(
    db,
    { handoff_ids: ["A", "B"], start_ts: "2026-11-02T00:00:00Z" },
    { now: NOW, t0RetentionDays: 30 },
  );
  expect(result?.tokens).toBe(100);
  expect(result?.handoff_ids_counted).toBe(1);
  expect(result?.complete).toBe(false);
  expect(result?.incomplete_reason).toBe("handoff_usage_missing");
  expect(LineageUsageSchema.safeParse(result).success).toBe(true);
});

test("lineageUsage returns null instead of a fake count when no handoff had usage", async () => {
  const fn = mod?.["lineageUsage"];
  expect(typeof fn).toBe("function");
  const usage = fn as LineageUsageFn;
  const db = freshDb();
  const result = await usage(
    db,
    { handoff_ids: ["A", "B"], start_ts: "2026-11-02T00:00:00Z" },
    { now: NOW, t0RetentionDays: 30 },
  );
  expect(result).toBeNull();
});

test("lineageUsage reports t0_retention_window when the lineage predates retention", async () => {
  const fn = mod?.["lineageUsage"];
  expect(typeof fn).toBe("function");
  const usage = fn as LineageUsageFn;
  const db = freshDb();
  insertUsageUpdate(db, "u-a", JSON.stringify({ handoff_id: "A", used: 100 }));
  insertUsageUpdate(db, "u-b", JSON.stringify({ handoff_id: "B", used: 50 }));
  const result = await usage(
    db,
    { handoff_ids: ["A", "B"], start_ts: "2026-10-03T00:00:00Z" },
    { now: NOW, t0RetentionDays: 30 },
  );
  expect(result?.complete).toBe(false);
  expect(result?.incomplete_reason).toBe("t0_retention_window");
  expect(LineageUsageSchema.safeParse(result).success).toBe(true);
});

test("extractTaskRefs collects issue refs from the message and branch names", () => {
  const fn = mod?.["extractTaskRefs"];
  expect(typeof fn).toBe("function");
  const extract = fn as (message: string, branchNames: readonly string[]) => TaskRefs;
  expect(extract("fix #390 regression", ["fix/issue-400_ab12cd34"]).issues).toEqual([390, 400]);
  expect(extract("#12 and #3 and issues/12", []).issues).toEqual([3, 12]);
});

test("extractTaskRefs collects operator bundle refs", () => {
  const fn = mod?.["extractTaskRefs"];
  expect(typeof fn).toBe("function");
  const extract = fn as (message: string, branchNames: readonly string[]) => TaskRefs;
  expect(extract("ship op-abc-123 now; loop-xyz", []).bundle_ids).toEqual(["abc-123"]);
});
