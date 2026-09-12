import type { WorkflowCtx } from "@penumbra/workflows";

import {
  type ChainStartRequest,
  DispatchEventLog,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  T0Writer,
} from "@penumbra/core";
import { loadTsWorkflow } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { emptyRecall } from "../_shared/test-helpers.js";
import { fn, inputSchema, type SwarmResult } from "./workflow.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

type TestCtx = WorkflowCtx & {
  chainStart?: (input: ChainStartRequest) => Promise<Response> | Response;
};

type ResponseMap = Map<string, { status: "completed" | "failed"; response_text: string | null }>;

function makeCtx(
  overrides: Partial<TestCtx> & {
    args?: Record<string, unknown>;
    responses?: ResponseMap;
  } = {},
): TestCtx {
  const responses =
    overrides.responses ??
    new Map<string, { status: "completed" | "failed"; response_text: string | null }>();
  const base: TestCtx = {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async (conversationId: string) => {
      const entry = responses.get(conversationId);
      if (entry) {
        return {
          status: entry.status,
          final_agent: "executor",
          response_text: entry.response_text,
        };
      }
      return { status: "completed" as const, final_agent: "executor", response_text: "done" };
    },
    cancel: async () => {},
    fileWrite: async (path: string) => path,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: overrides.args ?? {},
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "responses" || key === "args") continue;
    if (value !== undefined) (base as Record<string, unknown>)[key] = value;
  }
  return base;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedHandoff(
  db: Database,
  input: {
    handoffId: string;
    conversationId: string;
    branchName: string | null;
    parentHandoffId?: string | null;
    branchBase?: string | null;
    message?: string;
    status?: "completed" | "failed";
    reliability?: "good" | "bad";
    ts?: string;
  },
): void {
  const handoffs = new HandoffWriter({ db });
  const events = new DispatchEventLog(db);
  const ts = input.ts ?? "2026-09-12T10:00:00.000Z";

  handoffs.createApproved({
    handoff_id: input.handoffId,
    ts,
    project_id: "penumbra",
    conversation_id: input.conversationId,
    from: "workflow",
    to: "worker",
    to_role: "executor",
    message: input.message ?? "root task",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "review_adversarial",
    use_worktree: true,
    dispatch_kind: "workflow",
    parent_handoff_id: input.parentHandoffId ?? null,
    branch_base: input.branchBase ?? "main",
    branch_name: input.branchName,
  });

  handoffs.claimDispatch(input.handoffId, "worker-1");

  if (input.status === "failed") {
    handoffs.markFailed(input.handoffId, {
      reason: "failed",
      expected_worker_id: "worker-1",
    });
  } else {
    handoffs.markCompleted(input.handoffId, {
      ts: "2026-09-12T10:00:10.000Z",
      expected_worker_id: "worker-1",
    });
  }

  const goodReliability = input.reliability !== "bad";
  events.recordBatch([
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-09-12T10:00:01.000Z",
    },
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "proc.spawn",
      ts: "2026-09-12T10:00:02.000Z",
    },
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-09-12T10:00:09.000Z",
      meta: { committed: true, worktree_changed: goodReliability },
    },
  ]);
}

function seedResponse(
  db: Database,
  input: { conversationId: string; handoffId: string; response: string },
): void {
  new T0Writer(db).write({
    event_id: `response-${input.handoffId}`,
    ts: "2026-09-12T10:00:08.000Z",
    ingest_ts: "2026-09-12T10:00:08.000Z",
    source: "agentchat",
    source_detail: "worker",
    project_id: "penumbra",
    user_id: "test",
    machine_id: "test",
    session_id: input.conversationId,
    event_type: "agent-response",
    lane: "cli-subscription",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      response: input.response,
      handoff_id: input.handoffId,
      agent: "executor",
    },
    payload_summary: "agent-response",
    origin: "dispatch",
  });
}

function planJsonBlock(tasks: Record<string, unknown>[], summary = "test plan"): string {
  return "```json\n" + JSON.stringify({ summary, tasks }) + "\n```";
}

function planTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_class: "STANDARD",
    task_type: "implement_small",
    message: "do work",
    ...overrides,
  };
}

function isPlannerRequest(input: ChainStartRequest): boolean {
  return input.task_type === "plan_refine" && input.tool_free === true;
}

function plannerChainStart(): Response {
  return Response.json({
    conversation_id: "planner-conv",
    handoff_id: "planner-h",
    branch_name: null,
  });
}

function implChainStart(index: number, branchName: string | null): Response {
  return Response.json({
    conversation_id: `impl-conv-${index}`,
    handoff_id: `impl-h-${index}`,
    branch_name: branchName,
  });
}

function seedPlanner(db: Database, planResponse: string): void {
  seedHandoff(db, {
    handoffId: "planner-h",
    conversationId: "planner-conv",
    branchName: null,
  });
  seedResponse(db, {
    conversationId: "planner-conv",
    handoffId: "planner-h",
    response: planResponse,
  });
}

function seedImpl(
  db: Database,
  index: number,
  opts: {
    branchName?: string | null;
    response?: string;
    parentHandoffId?: string | null;
    branchBase?: string | null;
    message?: string;
    ts?: string;
  } = {},
): void {
  const branchName = opts.branchName ?? `feature/impl-${index}`;
  seedHandoff(db, {
    handoffId: `impl-h-${index}`,
    conversationId: `impl-conv-${index}`,
    branchName,
    parentHandoffId: opts.parentHandoffId ?? null,
    branchBase: opts.branchBase ?? "main",
    message: opts.message,
    ts: opts.ts,
  });
  seedResponse(db, {
    conversationId: `impl-conv-${index}`,
    handoffId: `impl-h-${index}`,
    response: opts.response ?? `impl response ${index}`,
  });
}

type SwarmRunOpts = {
  db?: Database;
  args?: Record<string, unknown>;
  responses?: ResponseMap;
  chainStart?: TestCtx["chainStart"];
  awaitChain?: TestCtx["awaitChain"];
  fileWrite?: TestCtx["fileWrite"];
  progress?: TestCtx["progress"];
  project?: string;
};

async function runSwarm(opts: SwarmRunOpts = {}): Promise<SwarmResult> {
  return (await fn(
    makeCtx({
      args: opts.args,
      responses: opts.responses,
      db: opts.db ? () => opts.db! : undefined,
      chainStart: opts.chainStart,
      awaitChain: opts.awaitChain,
      fileWrite: opts.fileWrite,
      progress: opts.progress,
      project: opts.project,
    }),
    emptyRecall(),
  )) as SwarmResult;
}

function defaultResponses(
  planResponse: string,
  implCount: number,
  implResponse = "impl response",
): ResponseMap {
  const map: ResponseMap = new Map();
  map.set("planner-conv", { status: "completed", response_text: planResponse });
  for (let i = 0; i < implCount; i++) {
    map.set(`impl-conv-${i}`, { status: "completed", response_text: `${implResponse} ${i}` });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Loader discovery
// ---------------------------------------------------------------------------

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("penumbra-swarm");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
  expect(loaded.inputSchema).toBeDefined();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("rejects unknown top-level keys", () => {
  const result = inputSchema.safeParse({ goal: "test", agentType: "executor" });
  expect(result.success).toBe(false);
});

test("rejects camelCase aliases (maxTasks, agentType, plannerModel)", () => {
  const r1 = inputSchema.safeParse({ goal: "test", maxTasks: 4 });
  const r2 = inputSchema.safeParse({ goal: "test", agentType: "executor" });
  const r3 = inputSchema.safeParse({ goal: "test", plannerModel: "opus" });
  expect(r1.success).toBe(false);
  expect(r2.success).toBe(false);
  expect(r3.success).toBe(false);
});

test("accepts explicit false values for use_worktree and isolated_install", () => {
  const result = inputSchema.safeParse({
    goal: "test",
    use_worktree: false,
    isolated_install: false,
  });
  expect(result.success).toBe(true);
  expect(result.data?.use_worktree).toBe(false);
  expect(result.data?.isolated_install).toBe(false);
});

test("defaults max_tasks to 8 and planner_agent to executor", () => {
  const result = inputSchema.safeParse({ goal: "test" });
  expect(result.data?.max_tasks).toBe(8);
  expect(result.data?.planner_agent).toBe("executor");
  expect(result.data?.timeout_ms).toBe(1_800_000);
});

test("rejects max_tasks over 16", () => {
  const result = inputSchema.safeParse({ goal: "test", max_tasks: 17 });
  expect(result.success).toBe(false);
});

test("accepts max_tasks 0", () => {
  const result = inputSchema.safeParse({ goal: "test", max_tasks: 0 });
  expect(result.success).toBe(true);
  expect(result.data?.max_tasks).toBe(0);
});

// ---------------------------------------------------------------------------
// max_tasks 0 — empty plan without dispatch
// ---------------------------------------------------------------------------

test("max_tasks 0 returns empty_plan without any dispatch", async () => {
  let chainStartCalls = 0;
  const result = await runSwarm({
    args: { goal: "test", max_tasks: 0 },
    chainStart: async () => {
      chainStartCalls += 1;
      return plannerChainStart();
    },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("empty_plan");
  expect(result.planner).toBeNull();
  expect(result.fanout).toBeNull();
  expect(result.branches).toEqual([]);
  expect(chainStartCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Planner dispatch contract
// ---------------------------------------------------------------------------

test("planner dispatched with tool_free true, use_worktree false, max_hops 1, task_type plan_refine", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const captured: ChainStartRequest[] = [];
    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test goal" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        captured.push(input);
        if (isPlannerRequest(input)) return plannerChainStart();
        const idx = implCount++;
        return implChainStart(idx, null);
      },
    });

    expect(result.ok).toBe(true);
    const plannerReq = captured.find(isPlannerRequest);
    expect(plannerReq).toBeDefined();
    expect(plannerReq?.tool_free).toBe(true);
    expect(plannerReq?.use_worktree).toBe(false);
    expect(plannerReq?.max_hops).toBe(1);
    expect(plannerReq?.task_type).toBe("plan_refine");
    expect(plannerReq?.initial_agent).toBe("executor");
  } finally {
    db.close();
  }
});

test("planner_agent pin forwards to initial_agent", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const captured: ChainStartRequest[] = [];
    let implCount = 0;
    await runSwarm({
      db,
      args: { goal: "test", planner_agent: "pinned-planner" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        captured.push(input);
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
    });

    const plannerReq = captured.find(isPlannerRequest);
    expect(plannerReq?.initial_agent).toBe("pinned-planner");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Planner reliability — fail closed BEFORE parsing
// ---------------------------------------------------------------------------

test("fails closed when planner reliability is untrustworthy (zero implementation dispatches)", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedHandoff(db, {
      handoffId: "planner-h",
      conversationId: "planner-conv",
      branchName: null,
      reliability: "bad",
    });
    seedResponse(db, {
      conversationId: "planner-conv",
      handoffId: "planner-h",
      response: plan,
    });

    let implChainStartCalls = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implChainStartCalls += 1;
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("planner_untrustworthy");
    expect(result.fanout).toBeNull();
    expect(implChainStartCalls).toBe(0);
    expect(result.planner?.reliability_trustworthy).toBe(false);
  } finally {
    db.close();
  }
});

test("fails closed when planner dispatch fails (zero implementation dispatches)", async () => {
  let implChainStartCalls = 0;
  const result = await runSwarm({
    args: { goal: "test" },
    chainStart: async (input) => {
      if (isPlannerRequest(input)) {
        return Response.json({ error: { code: "bad_request" } }, 400);
      }
      implChainStartCalls += 1;
      return implChainStart(0, null);
    },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("planner_untrustworthy");
  expect(result.fanout).toBeNull();
  expect(implChainStartCalls).toBe(0);
});

test("fails closed when chainStart is absent (zero implementation dispatches)", async () => {
  const result = await runSwarm({
    args: { goal: "test" },
    chainStart: undefined,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("planner_untrustworthy");
  expect(result.fanout).toBeNull();
});

test("fails closed when project scope is invalid (zero implementation dispatches)", async () => {
  let chainStartCalls = 0;
  const result = await runSwarm({
    args: { goal: "test" },
    project: "",
    chainStart: async () => {
      chainStartCalls += 1;
      return plannerChainStart();
    },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("planner_untrustworthy");
  expect(chainStartCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Plan parsing and validation
// ---------------------------------------------------------------------------

test("parses a valid plan and dispatches implementation tasks", async () => {
  const db = freshDb();
  try {
    const tasks = [
      planTask({ label: "task-a", message: "implement A" }),
      planTask({ label: "task-b", message: "implement B" }),
    ];
    const plan = planJsonBlock(tasks);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/impl-0" });
    seedImpl(db, 1, { branchName: "feature/impl-1" });

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 2),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        const idx = implCount++;
        return implChainStart(idx, null);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.plan?.task_count).toBe(2);
    expect(result.plan?.dropped_count).toBe(0);
    expect(result.fanout?.total).toBe(2);
    expect(result.fanout?.completed).toBe(2);
    expect(result.fanout?.failed).toBe(0);
    expect(result.branches).toEqual(["feature/impl-0", "feature/impl-1"]);
  } finally {
    db.close();
  }
});

test("truncates excess tasks to max_tasks with explicit dropped count", async () => {
  const db = freshDb();
  try {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      planTask({ label: `task-${i}`, message: `implement ${i}` }),
    );
    const plan = planJsonBlock(tasks);
    seedPlanner(db, plan);
    seedImpl(db, 0);
    seedImpl(db, 1);

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test", max_tasks: 2 },
      responses: defaultResponses(plan, 2),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        const idx = implCount++;
        return implChainStart(idx, null);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.plan?.task_count).toBe(2);
    expect(result.plan?.dropped_count).toBe(2);
    expect(result.fanout?.total).toBe(2);
  } finally {
    db.close();
  }
});

test("fails closed on duplicate task labels (zero implementation dispatches)", async () => {
  const db = freshDb();
  try {
    const tasks = [
      planTask({ label: "dup", message: "one" }),
      planTask({ label: "dup", message: "two" }),
    ];
    const plan = planJsonBlock(tasks);
    seedPlanner(db, plan);

    let implChainStartCalls = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 2),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implChainStartCalls += 1;
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_task_label");
    expect(result.fanout).toBeNull();
    expect(implChainStartCalls).toBe(0);
  } finally {
    db.close();
  }
});

test("fails closed on malformed plan (no json block)", async () => {
  const db = freshDb();
  try {
    const planResponse = "I cannot plan this.";
    seedPlanner(db, planResponse);

    let implChainStartCalls = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: new Map([["planner-conv", { status: "completed", response_text: planResponse }]]),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implChainStartCalls += 1;
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("plan_parse_failed");
    expect(result.fanout).toBeNull();
    expect(implChainStartCalls).toBe(0);
  } finally {
    db.close();
  }
});

test("fails closed on schema-violating plan (missing required task_class)", async () => {
  const db = freshDb();
  try {
    const badPlan =
      "```json\n" +
      JSON.stringify({
        summary: "bad",
        tasks: [{ task_type: "implement_small", message: "no class" }],
      }) +
      "\n```";
    seedPlanner(db, badPlan);

    let implChainStartCalls = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: new Map([["planner-conv", { status: "completed", response_text: badPlan }]]),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implChainStartCalls += 1;
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("plan_parse_failed");
    expect(implChainStartCalls).toBe(0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Response artifacts — artifact-only, bounded summary
// ---------------------------------------------------------------------------

test("writes full responses to artifacts and returns bounded summaries (no response_text)", async () => {
  const db = freshDb();
  try {
    const body = "line one\nline two\nline three";
    const plan = planJsonBlock([planTask({ label: "task-a" })]);
    seedPlanner(db, plan);
    seedImpl(db, 0, { response: body });

    const writes: { path: string; body: string }[] = [];
    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: new Map([
        ["planner-conv", { status: "completed", response_text: plan }],
        ["impl-conv-0", { status: "completed", response_text: body }],
      ]),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
      fileWrite: async (path, fileBody) => {
        writes.push({ path, body: fileBody });
        return path;
      },
    });

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("response_text");
    expect(result.fanout?.results[0]?.response_path).toBeTruthy();
    expect(result.fanout?.results[0]?.response_chars).toBe(body.length);
    expect(result.fanout?.results[0]?.check_line).toBe("line one");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe(body);
  } finally {
    db.close();
  }
});

test("invalid artifact write receipt fails the result closed", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        return implChainStart(0, null);
      },
      fileWrite: async () => "wrong-path",
    });

    expect(result.ok).toBe(false);
    expect(result.fanout?.results[0]?.ok).toBe(false);
    expect(result.fanout?.results[0]?.response_path).toBeNull();
    expect(result.fanout?.results[0]?.error_summary).toContain("response_artifact_write_failed");
    expect(result.branches).toEqual([]);
  } finally {
    db.close();
  }
});

test("empty string artifact receipt fails the result closed", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        return implChainStart(0, null);
      },
      fileWrite: async () => "",
    });

    expect(result.ok).toBe(false);
    expect(result.fanout?.results[0]?.ok).toBe(false);
    expect(result.fanout?.results[0]?.error_summary).toContain("response_artifact_write_failed");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Branch reporting — root vs latest
// ---------------------------------------------------------------------------

test("reports root branch_name and latest_branch_name from hops", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask({ label: "task-a" })]);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/root-branch", branchBase: "main" });
    seedHandoff(db, {
      handoffId: "impl-h-child",
      conversationId: "impl-conv-0",
      branchName: "feature/child-branch",
      parentHandoffId: "impl-h-0",
      branchBase: "feature/root-branch",
      message: "[silent-failure-retry] try again",
      status: "failed",
      ts: "2026-09-12T10:01:00.000Z",
    });

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, "stale-provisional");
      },
    });

    const r = result.fanout?.results[0];
    expect(r).toBeDefined();
    expect(r?.branch_name).toBe("feature/root-branch");
    expect(r?.latest_branch_name).toBe("feature/child-branch");
    expect(r?.latest_handoff_id).toBe("impl-h-child");
    expect(r?.root_handoff_id).toBe("impl-h-0");
    expect(r?.hop_count).toBe(2);
  } finally {
    db.close();
  }
});

test("latest_branch_name is null when latest_handoff_id has no matching hop", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/only-branch" });

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
    });

    const r = result.fanout?.results[0];
    expect(r?.latest_branch_name).toBe("feature/only-branch");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Explicit false preservation
// ---------------------------------------------------------------------------

test("preserves explicit false for use_worktree, isolated_install, tool_free in defaults", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const captured: ChainStartRequest[] = [];
    let implCount = 0;
    await runSwarm({
      db,
      args: {
        goal: "test",
        defaults: {
          use_worktree: false,
          isolated_install: false,
          tool_free: false,
          trust_mode: "config",
        },
      },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        captured.push(input);
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
    });

    const implReqs = captured.filter((r) => !isPlannerRequest(r));
    expect(implReqs.length).toBe(1);
    expect(implReqs[0]?.use_worktree).toBe(false);
    expect(implReqs[0]?.isolated_install).toBe(false);
    expect(implReqs[0]?.tool_free).toBe(false);
    expect(implReqs[0]?.trust_mode).toBe("config");
  } finally {
    db.close();
  }
});

test("top-level use_worktree false overrides defaults", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const captured: ChainStartRequest[] = [];
    let implCount = 0;
    await runSwarm({
      db,
      args: {
        goal: "test",
        use_worktree: false,
        defaults: { use_worktree: true },
      },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        captured.push(input);
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
    });

    const implReqs = captured.filter((r) => !isPlannerRequest(r));
    expect(implReqs[0]?.use_worktree).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Order preservation
// ---------------------------------------------------------------------------

test("preserves input order when implementation waits complete out of order", async () => {
  const db = freshDb();
  try {
    const tasks = [
      planTask({ label: "first", message: "one" }),
      planTask({ label: "second", message: "two" }),
    ];
    const plan = planJsonBlock(tasks);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/impl-0" });
    seedImpl(db, 1, { branchName: "feature/impl-1" });

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 2),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
      awaitChain: async (conversationId) => {
        if (conversationId === "impl-conv-0") {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const entry = defaultResponses(plan, 2).get(conversationId);
        return {
          status: entry?.status ?? "completed",
          final_agent: "executor",
          response_text: entry?.response_text ?? "done",
        };
      },
    });

    expect(result.fanout?.results.map((r) => r.label)).toEqual(["first", "second"]);
    expect(result.fanout?.results.map((r) => r.index)).toEqual([0, 1]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Planner summary
// ---------------------------------------------------------------------------

test("returns planner handoff reference and plan summary", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()], "decompose the goal");
    seedPlanner(db, plan);
    seedImpl(db, 0);

    let implCount = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
    });

    expect(result.planner).not.toBeNull();
    expect(result.planner?.handoff_id).toBe("planner-h");
    expect(result.planner?.conversation_id).toBe("planner-conv");
    expect(result.planner?.reliability_trustworthy).toBe(true);
    expect(result.plan?.summary).toBe("decompose the goal");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Progress milestones
// ---------------------------------------------------------------------------

test("emits bounded progress milestones", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask()]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const progress: { message: string; meta?: Record<string, unknown> }[] = [];
    let implCount = 0;
    await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implCount += 1;
        return implChainStart(implCount - 1, null);
      },
      progress: (message, meta) => progress.push({ message, meta }),
    });

    expect(progress.map((p) => p.message)).toEqual([
      "penumbra-swarm: planning",
      "penumbra-swarm: planner complete",
      "penumbra-swarm: dispatching",
      "penumbra-swarm: completed",
    ]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

test("registry loads penumbra-swarm with zero errors", async () => {
  const { buildRegistry } = await import("@penumbra/workflows");
  const repoRoot = join(import.meta.dir, "../../..");
  const reg = await buildRegistry({
    playbooksDir: join(repoRoot, "plugin/playbooks"),
    workflowsDir: join(repoRoot, "plugin/workflows"),
  });
  expect(reg.errors).toEqual([]);
  expect(reg.get("penumbra-swarm")?.name).toBe("penumbra-swarm");
});

// ---------------------------------------------------------------------------
// Bounded correction regressions (H1M2L0)
// ---------------------------------------------------------------------------

test("fails closed when an unlabeled task resolves to a duplicate label", async () => {
  const db = freshDb();
  try {
    const tasks = [planTask(), planTask({ label: "task-0" })];
    const plan = planJsonBlock(tasks);
    seedPlanner(db, plan);

    let implChainStartCalls = 0;
    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 2),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        implChainStartCalls += 1;
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_task_label");
    expect(result.fanout).toBeNull();
    expect(implChainStartCalls).toBe(0);
  } finally {
    db.close();
  }
});

test("public branches use the latest hop branch, not the root branch", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask({ label: "task-a" })]);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/root-branch", branchBase: "main" });
    seedHandoff(db, {
      handoffId: "impl-h-child",
      conversationId: "impl-conv-0",
      branchName: "feature/child-branch",
      parentHandoffId: "impl-h-0",
      branchBase: "feature/root-branch",
      message: "[silent-failure-retry] try again",
      status: "completed",
      ts: "2026-09-12T10:01:00.000Z",
    });

    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(true);
    const r = result.fanout?.results[0];
    expect(r?.branch_name).toBe("feature/root-branch");
    expect(r?.latest_branch_name).toBe("feature/child-branch");
    expect(result.branches).toEqual(["feature/child-branch"]);
  } finally {
    db.close();
  }
});

test("public branches do not fall back to root when the latest branch is unknown", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask({ label: "task-a" })]);
    seedPlanner(db, plan);
    seedImpl(db, 0, { branchName: "feature/root-branch", branchBase: "main" });
    seedHandoff(db, {
      handoffId: "impl-h-child",
      conversationId: "impl-conv-0",
      branchName: null,
      parentHandoffId: "impl-h-0",
      branchBase: "feature/root-branch",
      message: "[silent-failure-retry] try again",
      status: "completed",
      ts: "2026-09-12T10:01:00.000Z",
    });

    const result = await runSwarm({
      db,
      args: { goal: "test" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        if (isPlannerRequest(input)) return plannerChainStart();
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.fanout?.results[0]?.latest_branch_name).toBeNull();
    expect(result.branches).toEqual([]);
  } finally {
    db.close();
  }
});

test("rejects caller_cwd with control characters before planner dispatch", async () => {
  const chainStartCalls: ChainStartRequest[] = [];
  const badCwd = "/tmp/work\n; echo pwned";

  await expect(
    runSwarm({
      args: { goal: "test", caller_cwd: badCwd },
      chainStart: async (input) => {
        chainStartCalls.push(input);
        return plannerChainStart();
      },
    }),
  ).rejects.toThrow();

  expect(chainStartCalls).toHaveLength(0);
});

test("rejects relative caller_cwd before planner dispatch", async () => {
  const chainStartCalls: ChainStartRequest[] = [];

  await expect(
    runSwarm({
      args: { goal: "test", caller_cwd: "relative/path" },
      chainStart: async (input) => {
        chainStartCalls.push(input);
        return plannerChainStart();
      },
    }),
  ).rejects.toThrow();

  expect(chainStartCalls).toHaveLength(0);
});

test("planner prompt does not interpolate caller_cwd as a cd instruction", async () => {
  const db = freshDb();
  try {
    const plan = planJsonBlock([planTask({ label: "task-a" })]);
    seedPlanner(db, plan);
    seedImpl(db, 0);

    const captured: ChainStartRequest[] = [];
    const result = await runSwarm({
      db,
      args: { goal: "test", caller_cwd: "/tmp/valid path" },
      responses: defaultResponses(plan, 1),
      chainStart: async (input) => {
        captured.push(input);
        if (isPlannerRequest(input)) return plannerChainStart();
        return implChainStart(0, null);
      },
    });

    expect(result.ok).toBe(true);
    const plannerReq = captured.find(isPlannerRequest);
    expect(plannerReq?.message).not.toContain("cd /tmp/valid path");
    expect(plannerReq?.message).not.toMatch(/^cd /m);
    expect(plannerReq?.message).toContain("You are a dispatch planner");
  } finally {
    db.close();
  }
});

test("inputSchema accepts absolute caller_cwd with embedded spaces", () => {
  const result = inputSchema.safeParse({ goal: "test", caller_cwd: "/tmp/valid path" });
  expect(result.success).toBe(true);
});

test("inputSchema rejects caller_cwd with parent-directory traversal", () => {
  const result = inputSchema.safeParse({ goal: "test", caller_cwd: "/tmp/../etc" });
  expect(result.success).toBe(false);
  expect(result.error?.issues.some((i) => i.path.includes("caller_cwd"))).toBe(true);
});
