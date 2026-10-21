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
import { fn, inputSchema, type TournamentResult } from "./workflow.js";

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

type InspectionMock = {
  handoffId: string;
  diff?: string;
  log?: string;
  headSha?: string;
  branchName?: string;
  worktreeHandoffId?: string;
  worktreeBranchName?: string;
  status?: "created" | "merged" | "failed" | "expired";
  dirty?: boolean;
  diffTruncated?: boolean;
  logTruncated?: boolean;
  totalTruncated?: boolean;
  projectId?: string;
  baseRef?: string;
};

type ReinspectionOverride = {
  handoffId: string;
} & Partial<InspectionMock>;

type WorktreeInspection = Awaited<
  NonNullable<ReturnType<NonNullable<WorkflowCtx["worktreeInspect"]>>>
>;

const FULL_SHA_40 = "0123456789abcdef0123456789abcdef01234567";
const FULL_SHA_64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeInspection(handoffId: string, opts: Partial<InspectionMock> = {}): WorktreeInspection {
  return {
    worktree: {
      handoffId: opts.worktreeHandoffId ?? handoffId,
      path: `/tmp/worktree/${handoffId}`,
      branchName: opts.worktreeBranchName ?? opts.branchName ?? `feature/${handoffId}`,
      storageRoot: "/tmp/storage",
      createdAt: "2026-09-12T10:00:00.000Z",
      status: opts.status ?? "created",
      projectId: opts.projectId ?? "penumbra",
      worktreeMode: "symlink_mirror",
    },
    diff_against_main: opts.diff ?? "diff --git a/foo b/foo\n+changed",
    branch_log: opts.log ?? "abc1234 commit message",
    head_sha: opts.headSha ?? FULL_SHA_40,
    branch_name: opts.branchName ?? `feature/${handoffId}`,
    base_ref: opts.baseRef ?? "main",
    base_fallback: false,
    base_attempted_ref: opts.baseRef ?? "main",
    base_fallback_reason: null,
    dirty: opts.dirty ?? false,
    truncation: {
      diff_against_main: opts.diffTruncated ?? false,
      branch_log: opts.logTruncated ?? false,
      total: opts.totalTruncated ?? false,
    },
  };
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
    agent?: string;
    parentHandoffId?: string | null;
    branchBase?: string | null;
    message?: string;
    status?: "completed" | "failed";
    reliability?: "good" | "bad";
    ts?: string;
    taskType?: string;
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
    to: input.agent ?? "worker",
    to_role: "executor",
    message: input.message ?? "root task",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: input.taskType ?? "implement_small",
    use_worktree: true,
    dispatch_kind: "workflow",
    parent_handoff_id: input.parentHandoffId ?? null,
    branch_base: input.branchBase ?? "main",
    branch_name: input.branchName,
  });
  handoffs.claimDispatch(input.handoffId, "worker-1");
  if (input.status === "failed") {
    handoffs.markFailed(input.handoffId, { reason: "failed", expected_worker_id: "worker-1" });
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

function verdictJsonBlock(
  winnerBranch: string,
  winnerAgent: string,
  ranking: { branch: string; agent: string; score: number; notes?: string }[],
  rationale = "best candidate",
): string {
  return (
    "```json\n" +
    JSON.stringify({ winner_branch: winnerBranch, winner_agent: winnerAgent, rationale, ranking }) +
    "\n```"
  );
}

type MakeCtxOpts = {
  args?: Record<string, unknown>;
  db?: Database;
  chainStart?: TestCtx["chainStart"];
  awaitChain?: TestCtx["awaitChain"];
  worktreeInspect?: (handoffId: string) => Promise<WorktreeInspection | null>;
  deadline?: () => { remaining_ms: number | null; expired: boolean };
  fileWrite?: TestCtx["fileWrite"];
  progress?: TestCtx["progress"];
  project?: string;
};

function makeCtx(opts: MakeCtxOpts = {}): TestCtx {
  const ctx: TestCtx = {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async () => ({
      status: "completed" as const,
      final_agent: "executor",
      response_text: "done",
    }),
    cancel: async () => {},
    fileWrite: async (path: string) => path,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: opts.args ?? {},
    worktreeInspect: opts.worktreeInspect ?? (() => Promise.resolve(null)),
  };
  if (opts.db) ctx.db = () => opts.db!;
  if (opts.chainStart !== undefined) ctx.chainStart = opts.chainStart;
  if (opts.awaitChain !== undefined) ctx.awaitChain = opts.awaitChain;
  if (opts.deadline !== undefined) ctx.deadline = opts.deadline;
  if (opts.fileWrite !== undefined) ctx.fileWrite = opts.fileWrite;
  if (opts.progress !== undefined) ctx.progress = opts.progress;
  if (opts.project !== undefined) ctx.project = opts.project;
  return ctx;
}

type TournamentSetup = {
  agents: string[];
  branchNames: string[];
  judgeResponse: string;
  inspections?: InspectionMock[];
  reinspectionOverrides?: ReinspectionOverride[];
  dbOverrides?: {
    reliability?: "good" | "bad";
    status?: "completed" | "failed";
    branchName?: string | null;
    taskType?: string;
  }[];
};

function setupTournament(setup: TournamentSetup): {
  ctx: TestCtx;
  db: Database;
  capturedRequests: ChainStartRequest[];
} {
  const db = freshDb();
  const capturedRequests: ChainStartRequest[] = [];
  let candidateCount = 0;
  let judgeDispatched = false;

  for (let i = 0; i < setup.agents.length; i++) {
    const handoffId = `cand-h-${i}`;
    const conversationId = `cand-conv-${i}`;
    const branchName = setup.branchNames[i] ?? `feature/cand-${i}`;
    const overrides = setup.dbOverrides?.[i] ?? {};
    seedHandoff(db, {
      handoffId,
      conversationId,
      branchName: overrides.branchName ?? branchName,
      agent: setup.agents[i],
      reliability: overrides.reliability ?? "good",
      status: overrides.status ?? "completed",
      taskType: overrides.taskType,
    });
    seedResponse(db, { conversationId, handoffId, response: `candidate ${i} response` });
  }

  const judgeHandoffId = "judge-h";
  const judgeConversationId = "judge-conv";
  seedHandoff(db, {
    handoffId: judgeHandoffId,
    conversationId: judgeConversationId,
    branchName: null,
    agent: "executor",
  });
  seedResponse(db, {
    conversationId: judgeConversationId,
    handoffId: judgeHandoffId,
    response: setup.judgeResponse,
  });

  const inspectionMap = new Map((setup.inspections ?? []).map((insp) => [insp.handoffId, insp]));
  const reinspectionMap = new Map((setup.reinspectionOverrides ?? []).map((r) => [r.handoffId, r]));
  const inspectCallCounts = new Map<string, number>();

  const ctx = makeCtx({
    db,
    args: {
      task: { message: "implement feature X" },
      agents: setup.agents,
    },
    chainStart: async (input) => {
      capturedRequests.push(input);
      if (input.tool_free === true && input.use_worktree === false) {
        judgeDispatched = true;
        return Response.json({
          conversation_id: judgeConversationId,
          handoff_id: judgeHandoffId,
          branch_name: null,
        });
      }
      const idx = candidateCount++;
      return Response.json({
        conversation_id: `cand-conv-${idx}`,
        handoff_id: `cand-h-${idx}`,
        branch_name: null,
      });
    },
    awaitChain: async (conversationId) => {
      if (conversationId === judgeConversationId) {
        return {
          status: "completed",
          final_agent: "executor",
          response_text: setup.judgeResponse,
        };
      }
      const idx = Number(conversationId.split("-").pop());
      const overrides = setup.dbOverrides?.[idx] ?? {};
      if (overrides.status === "failed") {
        return {
          status: "failed" as const,
          final_agent: setup.agents[idx] ?? "executor",
          response_text: null,
        };
      }
      return {
        status: "completed" as const,
        final_agent: setup.agents[idx] ?? "executor",
        response_text: `candidate ${idx} response`,
      };
    },
    worktreeInspect: async (handoffId) => {
      const count = inspectCallCounts.get(handoffId) ?? 0;
      inspectCallCounts.set(handoffId, count + 1);
      const override = reinspectionMap.get(handoffId);
      if (count > 0 && override) {
        const base = inspectionMap.get(handoffId);
        return makeInspection(handoffId, {
          ...(base ?? {}),
          ...override,
        });
      }
      const mock = inspectionMap.get(handoffId);
      if (!mock) return makeInspection(handoffId);
      return makeInspection(handoffId, mock);
    },
  });

  return { ctx, db, capturedRequests };
}

async function runTournament(ctx: TestCtx): Promise<TournamentResult> {
  return (await fn(ctx, emptyRecall())) as TournamentResult;
}

// ---------------------------------------------------------------------------
// Loader discovery
// ---------------------------------------------------------------------------

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("penumbra-tournament");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
  expect(loaded.inputSchema).toBeDefined();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("rejects unknown top-level keys", () => {
  const result = inputSchema.safeParse({
    task: { message: "work" },
    agents: ["agent-a"],
    dispatcherModel: "sonnet",
  });
  expect(result.success).toBe(false);
});

test("rejects empty agents array", () => {
  const result = inputSchema.safeParse({ task: { message: "work" }, agents: [] });
  expect(result.success).toBe(false);
});

test("rejects missing task", () => {
  const result = inputSchema.safeParse({ agents: ["agent-a"] });
  expect(result.success).toBe(false);
});

test("rejects task without message", () => {
  const result = inputSchema.safeParse({ task: { label: "no-msg" }, agents: ["a"] });
  expect(result.success).toBe(false);
});

test("accepts all supported task fields including explicit false values", () => {
  const result = inputSchema.safeParse({
    task: {
      message: "work",
      use_worktree: false,
      isolated_install: false,
      trust_mode: "config",
    },
    agents: ["a", "b"],
  });
  expect(result.success).toBe(true);
});

// ---------------------------------------------------------------------------
// Missing ctx — stops before expenditure
// ---------------------------------------------------------------------------

test("returns missing_worktree_inspect_ctx when worktreeInspect is absent", async () => {
  let chainStartCalls = 0;
  const ctx = makeCtx({
    args: { task: { message: "work" }, agents: ["a"] },
    chainStart: async () => {
      chainStartCalls += 1;
      return Response.json({ conversation_id: "c", handoff_id: "h" });
    },
  });
  delete ctx.worktreeInspect;

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("missing_worktree_inspect_ctx");
  expect(chainStartCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Forced worktree — use_worktree:false is overridden to true
// ---------------------------------------------------------------------------

test("forces use_worktree true even when task requests false", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
      { branch: "feature/cand-1", agent: "agent-b", score: 6 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", headSha: FULL_SHA_40 },
      { handoffId: "cand-h-1", branchName: "feature/cand-1", headSha: FULL_SHA_40 },
    ],
  });
  ctx.args = {
    task: { message: "work", use_worktree: false },
    agents: ["agent-a", "agent-b"],
  };

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  const candidateRequests = capturedRequests.filter((r) => r.tool_free !== true);
  expect(candidateRequests).toHaveLength(2);
  for (const req of candidateRequests) {
    expect(req.use_worktree).toBe(true);
  }
});

test("preserves use_worktree true when task requests true", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  ctx.args = { task: { message: "work", use_worktree: true }, agents: ["agent-a"] };

  await runTournament(ctx);

  const candidateRequests = capturedRequests.filter((r) => r.tool_free !== true);
  expect(candidateRequests[0]?.use_worktree).toBe(true);
});

// ---------------------------------------------------------------------------
// Scope — project_id resolution
// ---------------------------------------------------------------------------

test("forwards an explicit same-scope project_id to chain_start", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  ctx.args = {
    task: { message: "work" },
    agents: ["agent-a"],
    project_id: "penumbra",
  };

  await runTournament(ctx);

  const candidateRequests = capturedRequests.filter((r) => r.tool_free !== true);
  expect(candidateRequests[0]?.project_id).toBe("penumbra");
});

test("defaults project_id to ctx.project when not specified", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  await runTournament(ctx);

  const candidateRequests = capturedRequests.filter((r) => r.tool_free !== true);
  expect(candidateRequests[0]?.project_id).toBe("penumbra");
});

test("rejects a project scope override before dispatching candidates", async () => {
  const { ctx, db, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  ctx.args = {
    task: { message: "work" },
    agents: ["agent-a"],
    project_id: "foreign-project",
  };

  try {
    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("scope_override_unsupported");
    expect(capturedRequests).toHaveLength(0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Role-route by default — judge uses executor
// ---------------------------------------------------------------------------

test("judge dispatched with initial_agent executor, use_worktree false, tool_free true", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  await runTournament(ctx);

  const judgeRequest = capturedRequests.find((r) => r.tool_free === true);
  expect(judgeRequest).toBeDefined();
  expect(judgeRequest?.initial_agent).toBe("executor");
  expect(judgeRequest?.use_worktree).toBe(false);
  expect(judgeRequest?.tool_free).toBe(true);
  expect(judgeRequest?.max_hops).toBe(1);
  expect(judgeRequest?.task_type).toBe("review_adversarial");
});

// ---------------------------------------------------------------------------
// Latest-hop — candidate with failed retry hop (no latest branch) is filtered
// ---------------------------------------------------------------------------

test("filters out candidate whose latest hop has no branch (failed retry)", async () => {
  const db = freshDb();
  try {
    const capturedRequests: ChainStartRequest[] = [];
    let candidateCount = 0;

    seedHandoff(db, {
      handoffId: "cand-h-0",
      conversationId: "cand-conv-0",
      branchName: "feature/cand-0",
      agent: "agent-a",
    });
    seedResponse(db, {
      conversationId: "cand-conv-0",
      handoffId: "cand-h-0",
      response: "candidate 0 response",
    });
    seedHandoff(db, {
      handoffId: "cand-h-0-retry",
      conversationId: "cand-conv-0",
      branchName: null,
      parentHandoffId: "cand-h-0",
      branchBase: "feature/cand-0",
      message: "[silent-failure-retry] try again",
      status: "failed",
      ts: "2026-09-12T10:01:00.000Z",
    });

    const ctx = makeCtx({
      db,
      args: { task: { message: "work" }, agents: ["agent-a"] },
      chainStart: async (input) => {
        capturedRequests.push(input);
        if (input.tool_free === true) {
          return Response.json({
            conversation_id: "judge-conv",
            handoff_id: "judge-h",
            branch_name: null,
          });
        }
        const idx = candidateCount++;
        return Response.json({
          conversation_id: `cand-conv-${idx}`,
          handoff_id: `cand-h-${idx}`,
          branch_name: null,
        });
      },
      awaitChain: async (conversationId) => {
        if (conversationId === "judge-conv") {
          return { status: "completed", final_agent: "executor", response_text: "" };
        }
        return {
          status: "completed",
          final_agent: "agent-a",
          response_text: "candidate 0 response",
        };
      },
      worktreeInspect: async () => makeInspection("cand-h-0"),
    });

    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_qualified_candidates");
    expect(result.candidates[0]?.ok).toBe(true);
    expect(result.candidates[0]?.reliability_trustworthy).toBe(true);
    expect(result.candidates[0]?.inspected).toBe(false);
    const judgeRequest = capturedRequests.find((r) => r.tool_free === true);
    expect(judgeRequest).toBeUndefined();
  } finally {
    db.close();
  }
});

test("uses the completed trusted latest hop identity for inspection and judging", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "root-h",
      conversationId: "candidate-conv",
      branchName: "feature/root",
      agent: "root-agent",
    });
    seedResponse(db, {
      conversationId: "candidate-conv",
      handoffId: "root-h",
      response: "root response only",
    });
    seedHandoff(db, {
      handoffId: "latest-h",
      conversationId: "candidate-conv",
      branchName: "feature/latest",
      parentHandoffId: "root-h",
      branchBase: "feature/root",
      agent: "latest-agent",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "judge-h",
      conversationId: "judge-conv",
      branchName: null,
      agent: "executor",
    });
    seedResponse(db, {
      conversationId: "judge-conv",
      handoffId: "judge-h",
      response: verdictJsonBlock("feature/latest", "latest-agent", [
        { branch: "feature/latest", agent: "latest-agent", score: 9 },
      ]),
    });
    const inspected: string[] = [];
    const ctx = makeCtx({
      db,
      args: { task: { message: "work" }, agents: ["root-agent"] },
      chainStart: async (input) =>
        Response.json(
          input.tool_free
            ? { conversation_id: "judge-conv", handoff_id: "judge-h", branch_name: null }
            : { conversation_id: "candidate-conv", handoff_id: "root-h", branch_name: null },
        ),
      awaitChain: async (conversationId) =>
        conversationId === "judge-conv"
          ? {
              status: "completed",
              final_agent: "executor",
              response_text: verdictJsonBlock("feature/latest", "latest-agent", [
                { branch: "feature/latest", agent: "latest-agent", score: 9 },
              ]),
            }
          : { status: "completed", final_agent: "root-agent", response_text: "root response only" },
      worktreeInspect: async (handoffId) => {
        inspected.push(handoffId);
        return makeInspection(handoffId, { branchName: "feature/latest" });
      },
    });

    const result = await runTournament(ctx);

    expect(result.ok).toBe(true);
    expect(result.winner).toBe("feature/latest");
    expect(result.winner_agent).toBe("latest-agent");
    expect(inspected).toEqual(["latest-h", "latest-h"]);
    expect(result.candidates[0]?.handoff_id).toBe("latest-h");
    expect(result.candidates[0]?.agent).toBe("latest-agent");
  } finally {
    db.close();
  }
});

test("does not qualify a healthy root when the completed latest hop is untrustworthy", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "root-h",
      conversationId: "candidate-conv",
      branchName: "feature/root",
      agent: "root-agent",
    });
    seedResponse(db, {
      conversationId: "candidate-conv",
      handoffId: "root-h",
      response: "root response only",
    });
    seedHandoff(db, {
      handoffId: "latest-h",
      conversationId: "candidate-conv",
      branchName: "feature/latest",
      parentHandoffId: "root-h",
      branchBase: "feature/root",
      agent: "latest-agent",
      reliability: "bad",
      ts: "2026-09-12T10:01:00.000Z",
    });
    let inspections = 0;
    const ctx = makeCtx({
      db,
      args: { task: { message: "work" }, agents: ["root-agent"] },
      chainStart: async () =>
        Response.json({
          conversation_id: "candidate-conv",
          handoff_id: "root-h",
          branch_name: null,
        }),
      awaitChain: async () => ({
        status: "completed",
        final_agent: "root-agent",
        response_text: "root response only",
      }),
      worktreeInspect: async () => {
        inspections += 1;
        return makeInspection("root-h", { branchName: "feature/root" });
      },
    });

    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_qualified_candidates");
    expect(inspections).toBe(0);
    expect(result.candidates[0]?.reliability_trustworthy).toBe(true);
    expect(result.candidates[0]?.inspection_valid).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Inspection unavailable — worktreeInspect returns null
// ---------------------------------------------------------------------------

test("filters out candidate whose worktreeInspect returns null", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-1", branchName: "feature/cand-1" }],
  });
  const originalInspect = ctx.worktreeInspect;
  if (!originalInspect) throw new Error("worktreeInspect missing");
  ctx.worktreeInspect = async (handoffId) => {
    if (handoffId === "cand-h-0") return null;
    return await originalInspect(handoffId);
  };

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.inspected).toBe(true);
  expect(result.candidates[0]?.inspection_valid).toBe(false);
  expect(result.candidates[0]?.inspection_state).toBe("unavailable");
  expect(result.candidates[1]?.inspected).toBe(true);
  expect(result.candidates[1]?.inspection_valid).toBe(true);
});

test("fails closed when worktree inspection is malformed instead of throwing", async () => {
  const { ctx, db, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
  });
  ctx.worktreeInspect = async () => ({}) as WorktreeInspection;

  try {
    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_qualified_candidates");
    expect(result.candidates[0]?.inspection_valid).toBe(false);
    expect(capturedRequests.some((request) => request.tool_free === true)).toBe(false);
  } finally {
    db.close();
  }
});

test("rejects an inspection whose worktree branch does not bind to the latest branch", async () => {
  const { ctx, db, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [
      {
        handoffId: "cand-h-0",
        branchName: "feature/cand-0",
        worktreeBranchName: "feature/foreign",
      },
    ],
  });

  try {
    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_qualified_candidates");
    expect(result.candidates[0]?.inspection_valid).toBe(false);
    expect(capturedRequests.some((request) => request.tool_free === true)).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Inspection dirty — dirty worktree is filtered
// ---------------------------------------------------------------------------

test("filters out candidate with dirty worktree", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", dirty: true },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.dirty).toBe(true);
  expect(result.candidates[0]?.inspection_valid).toBe(false);
  expect(result.candidates[1]?.inspection_valid).toBe(true);
});

// ---------------------------------------------------------------------------
// Inspection truncated — truncated inspection is filtered
// ---------------------------------------------------------------------------

test("filters out candidate with truncated inspection", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", totalTruncated: true },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.truncated).toBe(true);
  expect(result.candidates[0]?.inspection_valid).toBe(false);
});

// ---------------------------------------------------------------------------
// Inspection foreign — project mismatch is filtered
// ---------------------------------------------------------------------------

test("filters out candidate whose worktree project does not match ctx.project", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", projectId: "other-project" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1", projectId: "penumbra" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.inspection_valid).toBe(false);
  expect(result.candidates[1]?.inspection_valid).toBe(true);
});

// ---------------------------------------------------------------------------
// Inspection SHA — invalid head_sha is filtered
// ---------------------------------------------------------------------------

test("filters out candidate with invalid head_sha (not 40/64 hex)", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", headSha: "short" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1", headSha: FULL_SHA_64 },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.head_sha).toBe("short");
  expect(result.candidates[0]?.inspection_valid).toBe(false);
  expect(result.candidates[1]?.head_sha).toBe(FULL_SHA_64);
  expect(result.candidates[1]?.inspection_valid).toBe(true);
});

// ---------------------------------------------------------------------------
// No candidates — all fail
// ---------------------------------------------------------------------------

test("returns no_qualified_candidates without dispatching judge when all candidates fail", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: "",
    dbOverrides: [{ status: "failed" }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("no_qualified_candidates");
  expect(result.judge).toBeNull();
  const judgeRequest = capturedRequests.find((r) => r.tool_free === true);
  expect(judgeRequest).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Malformed judge — response doesn't match schema
// ---------------------------------------------------------------------------

test("fails on judge response with no json block", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: "I cannot judge this.",
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toContain("judge_parse_failed");
  expect(result.judge).not.toBeNull();
  expect(result.judge?.ok).toBe(true);
});

test("fails on judge response with schema-violating json", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: '```json\n{"winner_branch": "x"}\n```',
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toContain("judge_parse_failed");
});

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

test("rejects winner_branch that does not match any candidate", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/nonexistent", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("verdict_invalid:winner_branch_not_found");
  expect(result.verdict).not.toBeNull();
});

test("rejects winner_agent that does not match the candidate agent", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "wrong-agent", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("verdict_invalid:winner_agent_mismatch");
});

test("rejects incomplete ranking (fewer entries than candidates)", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("verdict_invalid:ranking_incomplete");
});

test("rejects ranking with duplicate branches", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
      { branch: "feature/cand-0", agent: "agent-a", score: 7 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("verdict_invalid:ranking_duplicate_branch");
});

test("rejects ranking entry with wrong agent identity", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
      { branch: "feature/cand-1", agent: "wrong-agent", score: 7 },
    ]),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("verdict_invalid:ranking_agent_mismatch");
});

test("rejects a ranking score outside the inclusive zero-to-ten range", async () => {
  const { ctx, db } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 11 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });

  try {
    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("judge_parse_failed");
    expect(result.qualified_count).toBe(1);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Re-inspection — winner head changed after judging
// ---------------------------------------------------------------------------

test("rejects winner when re-inspection head_sha changed", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0", headSha: FULL_SHA_40 }],
    reinspectionOverrides: [{ handoffId: "cand-h-0", headSha: FULL_SHA_64 }],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("winner_head_changed");
  expect(result.reinspection).not.toBeNull();
  expect(result.reinspection?.changed).toBe(true);
  expect(result.reinspection?.head_sha).toBe(FULL_SHA_64);
});

test("rejects winner when re-inspection returns null", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  const originalInspect = ctx.worktreeInspect;
  if (!originalInspect) throw new Error("worktreeInspect missing");
  let inspectCallCount = 0;
  ctx.worktreeInspect = async (handoffId) => {
    inspectCallCount += 1;
    if (inspectCallCount > 1) return null;
    return await originalInspect(handoffId);
  };

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("winner_reinspection_failed");
  expect(result.reinspection).toBeNull();
});

test("rejects a dirty winner reinspection even when its head is unchanged", async () => {
  const { ctx, db } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
    reinspectionOverrides: [{ handoffId: "cand-h-0", dirty: true }],
  });

  try {
    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("winner_reinspection_invalid");
    expect(result.qualified_count).toBe(1);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

test("returns deadline_expired when deadline is already expired before dispatch", async () => {
  let chainStartCalls = 0;
  const ctx = makeCtx({
    args: { task: { message: "work" }, agents: ["a"] },
    chainStart: async () => {
      chainStartCalls += 1;
      return Response.json({ conversation_id: "c", handoff_id: "h" });
    },
    deadline: () => ({ remaining_ms: 0, expired: true }),
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(false);
  expect(result.error).toBe("deadline_expired");
  expect(chainStartCalls).toBe(0);
});

test("returns deadline_expired_before_judge when deadline expires after fanout", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "cand-h-0",
      conversationId: "cand-conv-0",
      branchName: "feature/cand-0",
      agent: "agent-a",
    });
    seedResponse(db, {
      conversationId: "cand-conv-0",
      handoffId: "cand-h-0",
      response: "candidate 0 response",
    });

    let deadlineExpired = false;
    const ctx = makeCtx({
      db,
      args: { task: { message: "work" }, agents: ["agent-a"] },
      chainStart: async (input) => {
        if (input.tool_free === true) {
          return Response.json({
            conversation_id: "judge-conv",
            handoff_id: "judge-h",
            branch_name: null,
          });
        }
        return Response.json({
          conversation_id: "cand-conv-0",
          handoff_id: "cand-h-0",
          branch_name: null,
        });
      },
      awaitChain: async (conversationId) => {
        if (conversationId !== "judge-conv") {
          deadlineExpired = true;
        }
        return {
          status: "completed",
          final_agent: "agent-a",
          response_text: "candidate 0 response",
        };
      },
      worktreeInspect: async () => makeInspection("cand-h-0", { branchName: "feature/cand-0" }),
      deadline: () => ({
        remaining_ms: deadlineExpired ? 0 : 100000,
        expired: deadlineExpired,
      }),
    });

    const result = await runTournament(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("deadline_expired_before_judge");
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.inspected).toBe(true);
    expect(result.candidates[0]?.inspection_valid).toBe(true);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Happy path — full tournament with winner
// ---------------------------------------------------------------------------

test("completes a full tournament with two candidates and returns winner", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock(
      "feature/cand-0",
      "agent-a",
      [
        { branch: "feature/cand-0", agent: "agent-a", score: 9, notes: "clean" },
        { branch: "feature/cand-1", agent: "agent-b", score: 6, notes: "over-engineered" },
      ],
      "correct and minimal",
    ),
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0", diff: "clean diff", log: "good log" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1", diff: "messy diff", log: "ok log" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.error).toBeNull();
  expect(result.winner).toBe("feature/cand-0");
  expect(result.winner_agent).toBe("agent-a");
  expect(result.qualified_count).toBe(2);
  expect(result.branches).toEqual(["feature/cand-0", "feature/cand-1"]);
  expect(result.loser_branches).toEqual(["feature/cand-1"]);
  expect(result.verdict).not.toBeNull();
  expect(result.verdict?.ranking).toHaveLength(2);
  expect(result.judge).not.toBeNull();
  expect(result.judge?.ok).toBe(true);
  expect(result.reinspection).not.toBeNull();
  expect(result.reinspection?.changed).toBe(false);
});

// ---------------------------------------------------------------------------
// Preserve identity — task_class, trust_mode, branch_base, max_hops
// ---------------------------------------------------------------------------

test("preserves task_class, trust_mode, branch_base, max_hops from task in chain_start", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  ctx.args = {
    task: {
      message: "work",
      task_class: "BOUNDARY",
      trust_mode: "config",
      branch_base: "develop",
      max_hops: 3,
    },
    agents: ["agent-a"],
  };

  await runTournament(ctx);

  const candidateRequest = capturedRequests.find((r) => r.tool_free !== true);
  expect(candidateRequest?.task_class).toBe("BOUNDARY");
  expect(candidateRequest?.trust_mode).toBe("config");
  expect(candidateRequest?.branch_base).toBe("develop");
  expect(candidateRequest?.max_hops).toBe(3);
});

// ---------------------------------------------------------------------------
// No auto-land or cleanup — judge prompt says do NOT modify or land
// ---------------------------------------------------------------------------

test("judge prompt contains do NOT modify or land instruction", async () => {
  const { ctx, capturedRequests } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [
      {
        handoffId: "cand-h-0",
        branchName: "feature/cand-0",
        diff: "diff content",
        log: "log content",
        baseRef: "feature/stacked-base",
      },
    ],
  });

  await runTournament(ctx);

  const judgeRequest = capturedRequests.find((r) => r.tool_free === true);
  expect(judgeRequest?.message).toContain("Do NOT modify or land anything");
  expect(judgeRequest?.message).toContain("diff content");
  expect(judgeRequest?.message).toContain("**Diff against feature/stacked-base:**\ndiff content");
  expect(judgeRequest?.message).toContain("log content");
  expect(judgeRequest?.message).toContain("feature/cand-0");
  expect(judgeRequest?.message).toContain("agent-a");
});

// ---------------------------------------------------------------------------
// Reliability — untrustworthy candidate is filtered
// ---------------------------------------------------------------------------

test("filters out candidate with reliability_trustworthy false", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a", "agent-b"],
    branchNames: ["feature/cand-0", "feature/cand-1"],
    judgeResponse: verdictJsonBlock("feature/cand-1", "agent-b", [
      { branch: "feature/cand-1", agent: "agent-b", score: 9 },
    ]),
    dbOverrides: [
      { reliability: "bad", taskType: "implement_small" },
      { reliability: "good", taskType: "implement_small" },
    ],
    inspections: [
      { handoffId: "cand-h-0", branchName: "feature/cand-0" },
      { handoffId: "cand-h-1", branchName: "feature/cand-1" },
    ],
  });

  const result = await runTournament(ctx);

  expect(result.ok).toBe(true);
  expect(result.winner).toBe("feature/cand-1");
  expect(result.candidates[0]?.reliability_trustworthy).toBe(false);
  expect(result.candidates[0]?.inspected).toBe(false);
  expect(result.candidates[1]?.reliability_trustworthy).toBe(true);
});

// ---------------------------------------------------------------------------
// Progress milestones
// ---------------------------------------------------------------------------

test("emits bounded progress milestones", async () => {
  const { ctx } = setupTournament({
    agents: ["agent-a"],
    branchNames: ["feature/cand-0"],
    judgeResponse: verdictJsonBlock("feature/cand-0", "agent-a", [
      { branch: "feature/cand-0", agent: "agent-a", score: 9 },
    ]),
    inspections: [{ handoffId: "cand-h-0", branchName: "feature/cand-0" }],
  });
  const progress: { message: string; meta?: Record<string, unknown> }[] = [];
  ctx.progress = (message, meta) => progress.push({ message, meta });

  await runTournament(ctx);

  expect(progress.map((p) => p.message)).toEqual([
    "penumbra-tournament: competing",
    "penumbra-tournament: judging",
    "penumbra-tournament: completed",
  ]);
});

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

test("registry loads penumbra-tournament with zero errors", async () => {
  const { buildRegistry } = await import("@penumbra/workflows");
  const repoRoot = join(import.meta.dir, "../../..");
  const reg = await buildRegistry({
    playbooksDir: join(repoRoot, "plugin/playbooks"),
    workflowsDir: join(repoRoot, "plugin/workflows"),
  });
  expect(reg.errors).toEqual([]);
  expect(reg.get("penumbra-tournament")?.name).toBe("penumbra-tournament");
});
