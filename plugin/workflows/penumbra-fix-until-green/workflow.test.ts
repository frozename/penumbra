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
import { DEFAULT_INSPECT_SHA, type InspectConfig, makeInspection } from "./stage-test-helpers.js";
import { type FixUntilGreenResult, fn, inputSchema } from "./workflow.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

type TestCtx = WorkflowCtx & {
  chainStart?: (input: ChainStartRequest) => Promise<Response> | Response;
  capturedChainStarts?: ChainStartRequest[];
};

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
    reliability?: "good" | "bad" | "rewritten_history";
    ts?: string;
    chainTaskType?: string;
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
    chain_task_type: input.chainTaskType ?? "review_adversarial",
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
  const dispatchEndMeta =
    input.reliability === "rewritten_history"
      ? {
          committed: true,
          worktree_changed: true,
          commit_integrity: {
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            base_is_ancestor: false,
            identity: { name: "Penumbra Worker", email: "worker@example.com" },
            mismatched_commits: [],
          },
        }
      : { committed: true, worktree_changed: goodReliability };
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
      meta: dispatchEndMeta,
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

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

type FanoutResponseSpec = {
  response: string;
  branchName?: string;
  reliability?: "good" | "bad" | "rewritten_history";
  latestHop?: {
    handoffId: string;
    branchName: string | null;
    status?: "completed" | "failed";
    reliability?: "good" | "bad" | "rewritten_history";
  };
};

type VerifierResponseSpec = {
  ran: boolean;
  check_exit: number;
  parity_exit?: number;
  candidate_commit?: string | null;
  checkout_commit?: string | null;
  failing_segment?: string;
  output_tail?: string;
  notes?: string;
};

type GraderResponseSpec = {
  overall_pass?: boolean;
  criteria: { index: number; criterion: string; pass: boolean; evidence: string }[];
  notes?: string;
};

type TestSetup = {
  fanoutResponses: FanoutResponseSpec[];
  verifierResponses?: VerifierResponseSpec[];
  graderResponses?: GraderResponseSpec[];
  verifierDisabled?: boolean;
  verifierThrows?: boolean;
  graderThrows?: boolean;
  escalateTo?: string;
  maxRounds?: number;
  base?: string;
  rubric?: string[];
  allowPartialCheck?: boolean;
  check?: string;
  inspect?: InspectConfig;
  inspectUnavailable?: boolean;
};

type TestState = {
  db: Database;
  setup: TestSetup;
  fanoutRound: number;
  verifierCall: number;
  graderCall: number;
  capturedChainStarts: ChainStartRequest[];
  responses: Map<string, string | null>;
};

function startReviewStage(
  state: TestState,
  input: ChainStartRequest,
  kind: "verifier" | "grader",
): Response {
  const stageIndex = kind === "verifier" ? (state.verifierCall += 1) : (state.graderCall += 1);
  const conversationId = `${kind}-conv-${String(stageIndex)}`;
  const handoffId = `${kind}-handoff-${String(stageIndex)}`;
  const branchName = `${kind}/branch-${String(stageIndex)}`;
  const spec =
    kind === "verifier"
      ? state.setup.verifierResponses?.[stageIndex - 1]
      : state.setup.graderResponses?.[stageIndex - 1];
  const response = spec
    ? jsonBlock(
        kind === "verifier"
          ? {
              candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              checkout_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              ...spec,
            }
          : spec,
      )
    : null;
  seedHandoff(state.db, {
    handoffId,
    conversationId,
    branchName,
    branchBase: input.branch_base ?? null,
    reliability: "good",
    chainTaskType: "review_adversarial",
  });
  if (response) seedResponse(state.db, { conversationId, handoffId, response });
  state.responses.set(conversationId, response);
  return Response.json({
    conversation_id: conversationId,
    handoff_id: handoffId,
    branch_name: branchName,
  });
}

function startImplementation(state: TestState, input: ChainStartRequest): Response {
  state.fanoutRound += 1;
  const index = state.fanoutRound;
  const spec = state.setup.fanoutResponses[index - 1] ?? { response: "CHECK_RESULT: PASS" };
  const conversationId = `conv-${String(index)}`;
  const handoffId = `handoff-${String(index)}`;
  const branchName = spec.branchName ?? `feature/branch-${String(index)}`;
  seedHandoff(state.db, {
    handoffId,
    conversationId,
    branchName,
    branchBase: input.branch_base ?? "main",
    parentHandoffId: index > 1 ? `handoff-${String(index - 1)}` : null,
    reliability: spec.reliability ?? "good",
    chainTaskType: input.task_type ?? "implement_small",
  });
  seedResponse(state.db, { conversationId, handoffId, response: spec.response });
  if (spec.latestHop) {
    seedHandoff(state.db, {
      handoffId: spec.latestHop.handoffId,
      conversationId,
      branchName: spec.latestHop.branchName,
      branchBase: branchName,
      parentHandoffId: handoffId,
      message: "[silent-failure-retry] retry",
      status: spec.latestHop.status,
      reliability: spec.latestHop.reliability ?? spec.reliability ?? "good",
      chainTaskType: input.task_type ?? "implement_small",
      ts: "2026-09-12T10:01:00.000Z",
    });
  }
  state.responses.set(conversationId, spec.response);
  return Response.json({
    conversation_id: conversationId,
    handoff_id: handoffId,
    branch_name: branchName,
  });
}

function testChainStart(state: TestState, input: ChainStartRequest): Promise<Response> {
  state.capturedChainStarts.push(input);
  if (input.task_name === "verify-check") {
    if (state.setup.verifierThrows) return Promise.reject(new Error("verifier dispatch failed"));
    return Promise.resolve(startReviewStage(state, input, "verifier"));
  }
  if (input.task_name === "rubric-grade") {
    if (state.setup.graderThrows) return Promise.reject(new Error("grader dispatch failed"));
    return Promise.resolve(startReviewStage(state, input, "grader"));
  }
  return Promise.resolve(startImplementation(state, input));
}

function makeTestCtx(setup: TestSetup): TestCtx {
  const db = freshDb();
  const capturedChainStarts: ChainStartRequest[] = [];
  const responses = new Map<string, string | null>();
  const state: TestState = {
    db,
    setup,
    fanoutRound: 0,
    verifierCall: 0,
    graderCall: 0,
    capturedChainStarts,
    responses,
  };
  const inspectCfg = setup.inspect ?? {};
  const preMode = inspectCfg.pre ?? "default";
  const postMode = inspectCfg.post ?? "default";
  const preSha = inspectCfg.sha ?? DEFAULT_INSPECT_SHA;
  const postSha = inspectCfg.postSha ?? preSha;
  const inspectCalls = new Map<string, number>();

  function lookupBranchName(handoffId: string): string | null {
    const row = db
      .query<
        { branch_name: string | null },
        [string]
      >("SELECT branch_name FROM handoffs WHERE handoff_id = ?")
      .get(handoffId);
    return row?.branch_name ?? null;
  }

  function buildInspection(
    handoffId: string,
    mode: string,
    sha: string,
  ): ReturnType<typeof makeInspection> | null {
    const branchName = lookupBranchName(handoffId) ?? "unknown/branch";
    switch (mode) {
      case "missing":
        return null;
      case "throws":
        throw new Error("worktree inspect failed");
      case "dirty":
        return makeInspection(handoffId, branchName, sha, true);
      case "wrong_handoff":
        return makeInspection("other-handoff", branchName, sha, false);
      case "wrong_branch":
        return makeInspection(handoffId, "other/branch", sha, false);
      case "malformed_sha":
        return makeInspection(handoffId, branchName, "not-a-full-sha", false);
      default:
        return makeInspection(handoffId, branchName, sha, false);
    }
  }

  const ctx: TestCtx = {
    dispatch: () => Promise.reject(new Error("legacy dispatch must not be used")),
    awaitChain: (conversationId) =>
      Promise.resolve({
        status: "completed" as const,
        final_agent: "executor",
        response_text: responses.get(conversationId) ?? null,
      }),
    cancel: () => Promise.resolve(),
    fileWrite: (path: string) => Promise.resolve(path),
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: {},
    db: () => db,
    chainStart: (input) => testChainStart(state, input),
    capturedChainStarts,
    ...(setup.inspectUnavailable
      ? {}
      : {
          worktreeInspect: async (handoffId: string) => {
            const callIndex = inspectCalls.get(handoffId) ?? 0;
            inspectCalls.set(handoffId, callIndex + 1);
            const mode = callIndex === 0 ? preMode : postMode;
            const sha = callIndex === 0 ? preSha : postSha;
            return buildInspection(handoffId, mode, sha);
          },
        }),
  };

  return ctx;
}

function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: { message: "fix the bug" },
    check: "bun run lint:strict && bun run scripts/check-typecheck-coverage.ts",
    ...overrides,
  };
}

async function runWorkflow(
  setup: TestSetup,
  argsOverrides: Record<string, unknown> = {},
): Promise<{
  result: FixUntilGreenResult;
  ctx: TestCtx;
}> {
  const ctx = makeTestCtx(setup);
  const ctxWithArgs = { ...ctx, args: baseArgs(argsOverrides) };
  const result = (await fn(ctxWithArgs, emptyRecall())) as FixUntilGreenResult;
  return { result, ctx: ctxWithArgs };
}

// ---------------------------------------------------------------------------
// Loader discovery
// ---------------------------------------------------------------------------

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("penumbra-fix-until-green");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
  expect(loaded.inputSchema).toBeDefined();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("rejects unknown top-level keys", () => {
  const result = inputSchema.safeParse(baseArgs({ dispatcherModel: "sonnet" }));
  expect(result.success).toBe(false);
});

test("rejects missing task", () => {
  const result = inputSchema.safeParse({ check: "bun run typecheck" });
  expect(result.success).toBe(false);
});

test("rejects missing check", () => {
  const result = inputSchema.safeParse({ task: { message: "fix" } });
  expect(result.success).toBe(false);
});

test("rejects unknown task keys", () => {
  const result = inputSchema.safeParse(baseArgs({ task: { message: "fix", extra: true } }));
  expect(result.success).toBe(false);
});

test("rejects whitespace-only task, check, and rubric criteria", () => {
  expect(inputSchema.safeParse(baseArgs({ task: { message: " " } })).success).toBe(false);
  expect(inputSchema.safeParse(baseArgs({ check: " " })).success).toBe(false);
  expect(inputSchema.safeParse(baseArgs({ rubric: [" "] })).success).toBe(false);
});

test("rejects rubric criteria that collide after normalization", () => {
  const result = inputSchema.safeParse(baseArgs({ rubric: ["1. Add tests.", "add   tests"] }));
  expect(result.success).toBe(false);
});

test("rejects max_rounds < 1", () => {
  const result = inputSchema.safeParse(baseArgs({ max_rounds: 0 }));
  expect(result.success).toBe(false);
});

test("rejects max_rounds > 10", () => {
  const result = inputSchema.safeParse(baseArgs({ max_rounds: 11 }));
  expect(result.success).toBe(false);
});

test("accepts all supported fields including explicit false values", () => {
  const result = inputSchema.safeParse(
    baseArgs({
      verify_check: false,
      allow_partial_check: true,
      isolated_install: false,
      project_id: "penumbra",
      repo: "/tmp/work",
      caller_cwd: "/tmp/work",
    }),
  );
  expect(result.success).toBe(true);
});

test("rejects a differing project scope before any dispatch", async () => {
  const ctx = makeTestCtx({ fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] });
  await expect(
    fn({ ...ctx, args: baseArgs({ project_id: "other-project" }) }, emptyRecall()),
  ).rejects.toThrow("scope");
  expect(ctx.capturedChainStarts).toEqual([]);
});

test("rejects differing repo and caller_cwd aliases before any dispatch", async () => {
  for (const args of [{ repo: "/tmp/other" }, { caller_cwd: "/tmp/other" }]) {
    const ctx = makeTestCtx({ fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] });
    await expect(fn({ ...ctx, args: baseArgs(args) }, emptyRecall())).rejects.toThrow("scope");
    expect(ctx.capturedChainStarts).toEqual([]);
  }
});

test("threads an explicit same-scope project through implementation verifier and grader", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
      graderResponses: [
        {
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
        },
      ],
      rubric: ["criterion one"],
    },
    {
      project_id: "penumbra",
      repo: "/tmp/work",
      caller_cwd: "/tmp/work",
      rubric: ["criterion one"],
    },
  );
  expect(result.ok).toBe(true);
  expect(ctx.capturedChainStarts).toHaveLength(3);
  expect(ctx.capturedChainStarts?.map((start) => start.project_id)).toEqual([
    "penumbra",
    "penumbra",
    "penumbra",
  ]);
});

test("preserves explicit isolated_install false on implementation dispatch", async () => {
  const { ctx } = await runWorkflow(
    { fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] },
    { verify_check: false, isolated_install: false },
  );
  expect(ctx.capturedChainStarts?.[0]?.isolated_install).toBe(false);
});

test("defaults agent to executor", () => {
  const parsed = inputSchema.parse(baseArgs());
  expect(parsed.agent).toBe("executor");
});

test("defaults max_rounds to 3", () => {
  const parsed = inputSchema.parse(baseArgs());
  expect(parsed.max_rounds).toBe(3);
});

test("defaults verify_check to true", () => {
  const parsed = inputSchema.parse(baseArgs());
  expect(parsed.verify_check).toBe(true);
});

test("defaults base to main", () => {
  const parsed = inputSchema.parse(baseArgs());
  expect(parsed.base).toBe("main");
});

test("defaults timeout_ms to 1800000", () => {
  const parsed = inputSchema.parse(baseArgs());
  expect(parsed.timeout_ms).toBe(1_800_000);
});

// ---------------------------------------------------------------------------
// Check validation
// ---------------------------------------------------------------------------

test("rejects check without lint:strict by default", async () => {
  const ctx = makeTestCtx({ fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] });
  const ctxWithArgs = {
    ...ctx,
    args: baseArgs({ check: "bun run scripts/check-typecheck-coverage.ts" }),
  };
  await expect(fn(ctxWithArgs, emptyRecall())).rejects.toThrow("lint:strict");
});

test("rejects check without check-typecheck-coverage.ts by default", async () => {
  const ctx = makeTestCtx({ fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] });
  const ctxWithArgs = { ...ctx, args: baseArgs({ check: "bun run lint:strict" }) };
  await expect(fn(ctxWithArgs, emptyRecall())).rejects.toThrow("check-typecheck-coverage.ts");
});

test("accepts check without lint:strict when allow_partial_check is true", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
    },
    { check: "bun run test", allow_partial_check: true },
  );
  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
});

// ---------------------------------------------------------------------------
// Round 1 PASS with verification
// ---------------------------------------------------------------------------

test("round 1 PASS with verification passes", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });
  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  expect(result.rounds_used).toBe(1);
  expect(result.final_branch).toBe("feature/branch-1");
});

test("round 1 PASS without verification (verify_check: false) passes", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    },
    { verify_check: false },
  );
  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.check_verify_status).toBe("skipped");
  expect(ctx.capturedChainStarts?.[0]?.max_hops).toBe(1);
});

test("verify_check false still requires a supplied rubric and dispatches its grader through fanout", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      graderResponses: [
        {
          overall_pass: true,
          criteria: [{ index: 1, criterion: "fix the bug", pass: true, evidence: "ok" }],
        },
      ],
    },
    { verify_check: false, rubric: ["fix the bug"] },
  );

  expect(result.ok).toBe(true);
  expect(result.rounds[0]?.rubric_status).toBe("PASSED");
  expect(ctx.capturedChainStarts).toHaveLength(2);
  expect(ctx.capturedChainStarts?.[1]).toMatchObject({
    initial_agent: "grader",
    task_type: "review_adversarial",
    use_worktree: true,
    branch_base: DEFAULT_INSPECT_SHA,
    isolated_install: true,
    max_hops: 1,
    tool_free: false,
  });
});

// ---------------------------------------------------------------------------
// Round 1 FAIL, Round 2 PASS (different branch)
// ---------------------------------------------------------------------------

test("round 1 FAIL, round 2 PASS uses previous branch as base", async () => {
  const { result, ctx } = await runWorkflow({
    fanoutResponses: [
      { response: "CHECK_RESULT: FAIL\nerror output" },
      { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
    ],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });

  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  expect(result.rounds_used).toBe(2);
  expect(result.rounds).toHaveLength(2);
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[1]?.passed).toBe(true);
  expect(ctx.capturedChainStarts?.slice(0, 2).map((start) => start.max_hops)).toEqual([1, 1]);

  // Verify round 2 used round 1's branch as base, NOT the original base
  const chainStarts = ctx as TestCtx & {
    chainStart?: (input: ChainStartRequest) => Promise<Response>;
  };
  // The chainStart is captured in the makeTestCtx closure, but we can verify
  // via the round records: round 2's hops should show branch_base = feature/branch-1
  expect(result.rounds[1]?.hops.branch_base).toBe("feature/branch-1");
});

test("round 2 branch_base is the previous candidate branch, not the original base", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: FAIL\nerror" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
      ],
      verifierResponses: [{ ran: true, check_exit: 0 }],
    },
    { base: "develop" },
  );

  expect(result.ok).toBe(true);
  // Round 1 should use "develop" as base
  expect(result.rounds[0]?.hops.branch_base).toBe("develop");
  // Round 2 should use "feature/branch-1" (round 1's branch), NOT "develop"
  expect(result.rounds[1]?.hops.branch_base).toBe("feature/branch-1");
});

test("an actual multi-hop DB result rejects the root CHECK response for a trustworthy latest child", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [
        {
          response: "CHECK_RESULT: PASS",
          branchName: "feature/root-branch",
          latestHop: {
            handoffId: "latest-handoff-1",
            branchName: "feature/latest-branch",
          },
        },
      ],
    },
    { verify_check: false },
  );

  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.reason).toBe("candidate_response_handoff_mismatch");
  expect(result.rounds[0]?.hops.root_handoff_id).toBe("handoff-1");
  expect(result.rounds[0]?.hops.latest_handoff_id).toBe("latest-handoff-1");
  expect(ctx.capturedChainStarts).toHaveLength(1);
});

test("an actual multi-hop DB result rejects untrustworthy latest reliability despite a good root", async () => {
  const { result, ctx } = await runWorkflow({
    fanoutResponses: [
      {
        response: "CHECK_RESULT: PASS",
        reliability: "good",
        latestHop: {
          handoffId: "latest-handoff-1",
          branchName: "feature/latest-branch",
          reliability: "bad",
        },
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.reason).toBe("candidate_latest_reliability_untrustworthy");
  expect(ctx.capturedChainStarts).toHaveLength(1);
});

test("a round whose dispatch left its base stops via candidate_latest_reliability_untrustworthy", async () => {
  const { result, ctx } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS", reliability: "rewritten_history" }],
  });
  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.reason).toBe("candidate_latest_reliability_untrustworthy");
  expect(ctx.capturedChainStarts).toHaveLength(1);
});

test("a non-completed latest hop fails closed before another stage dispatch", async () => {
  const { result, ctx } = await runWorkflow({
    fanoutResponses: [
      {
        response: "CHECK_RESULT: PASS",
        branchName: "feature/root-branch",
        latestHop: {
          handoffId: "failed-latest-handoff",
          branchName: "feature/failed-latest",
          status: "failed",
        },
      },
    ],
  });

  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.reason).toBe("candidate_latest_handoff_not_completed");
  expect(ctx.capturedChainStarts).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Poisoned recall never used
// ---------------------------------------------------------------------------

test("poisoned recall never affects branch selection", async () => {
  const poisonedRecall = emptyRecall({
    byKey: {
      "git.diff": "feature/poisoned-branch",
      "git.show": [{ sha: "poison", subject: "poison", ts: "", body: "" }],
    },
  });
  const ctx = makeTestCtx({
    fanoutResponses: [
      { response: "CHECK_RESULT: FAIL\nerror" },
      { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
    ],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });
  const ctxWithArgs = { ...ctx, args: baseArgs({}) };
  const result = (await fn(ctxWithArgs, poisonedRecall)) as FixUntilGreenResult;

  expect(result.ok).toBe(true);
  // Round 2 base is the previous branch, not anything from recall
  expect(result.rounds[1]?.hops.branch_base).toBe("feature/branch-1");
});

// ---------------------------------------------------------------------------
// Verification: worker PASS but verifier nonzero
// ---------------------------------------------------------------------------

test("worker PASS but verifier nonzero exit fails and feeds next round", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [
      { response: "CHECK_RESULT: PASS" },
      { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
    ],
    verifierResponses: [
      { ran: true, check_exit: 1, failing_segment: "typecheck", output_tail: "error" },
      { ran: true, check_exit: 0 },
    ],
  });

  expect(result.ok).toBe(true);
  expect(result.rounds_used).toBe(2);
  expect(result.rounds[0]?.check_verify_status).toBe("failed");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[1]?.check_verify_status).toBe("passed");
  expect(result.rounds[1]?.passed).toBe(true);
});

// ---------------------------------------------------------------------------
// Verification: verifier not run (ran:false)
// ---------------------------------------------------------------------------

test("verifier not run (ran:false) fails and feeds next round", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [
      { response: "CHECK_RESULT: PASS" },
      { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
    ],
    verifierResponses: [
      { ran: false, check_exit: -1, notes: "could not locate worktree" },
      { ran: true, check_exit: 0 },
    ],
  });

  expect(result.ok).toBe(true);
  expect(result.rounds[0]?.check_verify_status).toBe("not_run");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[1]?.check_verify_status).toBe("passed");
});

// ---------------------------------------------------------------------------
// Two notruns stop
// ---------------------------------------------------------------------------

test("two consecutive verifier not-runs stop the workflow", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: PASS" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-3" },
      ],
      verifierResponses: [
        { ran: false, check_exit: -1 },
        { ran: false, check_exit: -1 },
      ],
    },
    { max_rounds: 5 },
  );

  expect(result.ok).toBe(false);
  expect(result.rounds_used).toBe(2);
  expect(result.rounds).toHaveLength(2);
  expect(result.rounds[0]?.check_verify_status).toBe("not_run");
  expect(result.rounds[1]?.check_verify_status).toBe("not_run");
});

// ---------------------------------------------------------------------------
// Verifier unavailable stops
// ---------------------------------------------------------------------------

test("verifier unavailable stops the workflow", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierThrows: true,
  });

  expect(result.ok).toBe(false);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.check_verify_status).toBe("unavailable");
  expect(result.rounds[0]?.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Bounded round escalation
// ---------------------------------------------------------------------------

test("stops after max_rounds when all rounds fail check", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: FAIL\nerror 1" },
        { response: "CHECK_RESULT: FAIL\nerror 2" },
        { response: "CHECK_RESULT: FAIL\nerror 3" },
      ],
    },
    { max_rounds: 3, verify_check: false },
  );

  expect(result.ok).toBe(false);
  expect(result.green).toBe(false);
  expect(result.rounds_used).toBe(3);
  expect(result.rounds).toHaveLength(3);
  expect(result.rounds.every((r) => !r.passed)).toBe(true);
});

// ---------------------------------------------------------------------------
// Last-round escalation
// ---------------------------------------------------------------------------

test("escalates to escalate_to on the last round", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: FAIL\nerror 1" },
        { response: "CHECK_RESULT: FAIL\nerror 2" },
        { response: "CHECK_RESULT: PASS" },
      ],
      verifierResponses: [{ ran: true, check_exit: 0 }],
    },
    { max_rounds: 3, escalate_to: "opus" },
  );

  expect(result.ok).toBe(true);
  expect(result.rounds_used).toBe(3);
  expect(result.rounds[2]?.agent).toBe("opus");
  expect(result.rounds[0]?.agent).toBe("executor");
  expect(result.rounds[1]?.agent).toBe("executor");
});

// ---------------------------------------------------------------------------
// Rubric: pass
// ---------------------------------------------------------------------------

test("rubric pass after check+verify pass", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
      graderResponses: [
        {
          overall_pass: true,
          criteria: [
            { index: 1, criterion: "fix the bug", pass: true, evidence: "ok" },
            { index: 2, criterion: "add tests", pass: true, evidence: "ok" },
          ],
        },
      ],
    },
    { rubric: ["fix the bug", "add tests"] },
  );

  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.rubric_status).toBe("PASSED");
});

// ---------------------------------------------------------------------------
// Rubric: criterion fails, feeds next round
// ---------------------------------------------------------------------------

test("rubric criterion fail feeds next round", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: PASS" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
      ],
      verifierResponses: [
        { ran: true, check_exit: 0 },
        { ran: true, check_exit: 0 },
      ],
      graderResponses: [
        {
          overall_pass: false,
          criteria: [
            { index: 1, criterion: "fix the bug", pass: true, evidence: "ok" },
            { index: 2, criterion: "add tests", pass: false, evidence: "no tests" },
          ],
        },
        {
          overall_pass: true,
          criteria: [
            { index: 1, criterion: "fix the bug", pass: true, evidence: "ok" },
            { index: 2, criterion: "add tests", pass: true, evidence: "ok" },
          ],
        },
      ],
    },
    { rubric: ["fix the bug", "add tests"] },
  );

  expect(result.ok).toBe(true);
  expect(result.rounds_used).toBe(2);
  expect(result.rounds[0]?.rubric_status).toBe("FAILED");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[1]?.rubric_status).toBe("PASSED");
  expect(result.rounds[1]?.passed).toBe(true);
  const secondImplementation = ctx.capturedChainStarts?.find(
    (start) => start.task_name === "fix-2",
  );
  expect(secondImplementation?.message).toContain("add tests");
  expect(secondImplementation?.message).toContain("no tests");
});

// ---------------------------------------------------------------------------
// Rubric: missing criteria fail (coverage bypass)
// ---------------------------------------------------------------------------

test("rubric missing criteria fail even with overall_pass true", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: PASS" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
      ],
      verifierResponses: [
        { ran: true, check_exit: 0 },
        { ran: true, check_exit: 0 },
      ],
      graderResponses: [
        {
          overall_pass: true,
          criteria: [{ index: 1, criterion: "fix the bug", pass: true, evidence: "ok" }],
        },
        {
          overall_pass: true,
          criteria: [
            { index: 1, criterion: "fix the bug", pass: true, evidence: "ok" },
            { index: 2, criterion: "add tests", pass: true, evidence: "ok" },
          ],
        },
      ],
    },
    { rubric: ["fix the bug", "add tests"] },
  );

  expect(result.ok).toBe(true);
  expect(result.rounds_used).toBe(2);
  expect(result.rounds[0]?.rubric_status).toBe("FAILED");
  expect(result.rounds[0]?.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Rubric: grader unavailable fails closed
// ---------------------------------------------------------------------------

test("rubric grader unavailable fails closed and stops", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
      graderThrows: true,
    },
    { rubric: ["fix the bug"] },
  );

  expect(result.ok).toBe(false);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
  expect(result.rounds[0]?.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// Dispatch failure stops
// ---------------------------------------------------------------------------

test("untrustworthy latest dispatch stops immediately", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS", reliability: "bad" }],
  });

  expect(result.ok).toBe(false);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.dispatch_ok).toBe(false);
  expect(result.rounds[0]?.reason).toBe("candidate_latest_reliability_untrustworthy");
});

// ---------------------------------------------------------------------------
// No response body leaks
// ---------------------------------------------------------------------------

test("round records do not leak response body", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS\nsecret response body" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("secret response body");
});

// ---------------------------------------------------------------------------
// Verifier dispatch contract
// ---------------------------------------------------------------------------

test("verifier dispatch uses task_type review_adversarial, use_worktree, branch_base", async () => {
  const ctx = makeTestCtx({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });
  const ctxWithArgs = { ...ctx, args: baseArgs() };
  const result = (await fn(ctxWithArgs, emptyRecall())) as FixUntilGreenResult;
  expect(result.rounds[0]?.verifier_handoff_id).toBeTruthy();
  expect(ctx.capturedChainStarts).toHaveLength(2);
  expect(ctx.capturedChainStarts?.[1]).toMatchObject({
    initial_agent: "verifier",
    task_type: "review_adversarial",
    use_worktree: true,
    branch_base: DEFAULT_INSPECT_SHA,
    isolated_install: true,
    max_hops: 1,
    tool_free: true,
  });
});

test("grader receives the authoritative candidate handoff id instead of null", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
      graderResponses: [
        {
          overall_pass: true,
          criteria: [{ index: 1, criterion: "fix the bug", pass: true, evidence: "ok" }],
        },
      ],
    },
    { rubric: ["fix the bug"] },
  );

  expect(result.ok).toBe(true);
  const graderPrompt = ctx.capturedChainStarts?.find(
    (start) => start.initial_agent === "grader",
  )?.message;
  expect(graderPrompt).toContain("Handoff id: handoff-1");
  expect(graderPrompt).not.toContain("Handoff id: null");
  expect(result.rounds[0]?.grader_handoff_id).toBe("grader-handoff-1");
  expect(result.rounds[0]?.grader_branch).toBe("grader/branch-1");
});

// ---------------------------------------------------------------------------
// Timeout propagation
// ---------------------------------------------------------------------------

test("timeout in fanout awaitChain causes round failure", async () => {
  const db = freshDb();
  let fanoutRound = 0;
  const ctx: TestCtx = {
    dispatch: async () => ({ conversation_id: "verifier-conv", handoff_id: "verifier-handoff" }),
    awaitChain: async (conversationId: string) => {
      if (conversationId.startsWith("conv-")) {
        return { status: "timeout" as const, final_agent: null, response_text: null };
      }
      return { status: "completed", final_agent: "verifier", response_text: null };
    },
    cancel: async () => {},
    fileWrite: async (path: string) => path,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: baseArgs({ verify_check: false }),
    db: () => db,
    chainStart: async (input: ChainStartRequest) => {
      fanoutRound += 1;
      const conversationId = `conv-${fanoutRound}`;
      const handoffId = `handoff-${fanoutRound}`;
      const branchName = `feature/branch-${fanoutRound}`;
      seedHandoff(db, {
        handoffId,
        conversationId,
        branchName,
        branchBase: input.branch_base ?? "main",
        reliability: "good",
        chainTaskType: input.task_type ?? "implement_small",
      });
      return Response.json({
        conversation_id: conversationId,
        handoff_id: handoffId,
        branch_name: branchName,
      });
    },
  };

  const result = (await fn(ctx, emptyRecall())) as FixUntilGreenResult;

  expect(result.ok).toBe(false);
  expect(result.rounds_used).toBe(1);
  expect(result.rounds[0]?.dispatch_ok).toBe(false);
});

// ---------------------------------------------------------------------------
// Inspection binding: workflow-level fail-closed
// ---------------------------------------------------------------------------

test("workflow stops when worktreeInspect is unavailable", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
    inspectUnavailable: true,
  });
  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.check_verify_status).toBe("unavailable");
  expect(result.rounds[0]?.passed).toBe(false);
});

test("workflow stops when pre-inspection reports dirty worktree", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
    inspect: { pre: "dirty" },
  });
  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.check_verify_status).toBe("unavailable");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.last_output).toContain("dirty");
});

test("workflow stops when post-inspection HEAD changed after verifier", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
    inspect: { postSha: "cccccccccccccccccccccccccccccccccccccccc" },
  });
  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.check_verify_status).toBe("unavailable");
  expect(result.rounds[0]?.passed).toBe(false);
});

test("workflow verifier dispatch uses host-observed SHA as branch_base", async () => {
  const { ctx } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });
  const verifierStart = ctx.capturedChainStarts?.find(
    (start) => start.task_name === "verify-check",
  );
  expect(verifierStart?.branch_base).toBe(DEFAULT_INSPECT_SHA);
  expect(verifierStart?.branch_base).not.toBe("feature/branch-1");
});

// ---------------------------------------------------------------------------
// CI parity check
// ---------------------------------------------------------------------------

test("inputSchema accepts an optional parity_check string", () => {
  const result = inputSchema.safeParse(baseArgs({ parity_check: "bun run check:ci" }));
  expect(result.success).toBe(true);
});

test("worker PASS with verifier parity_exit nonzero fails the round", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [
        {
          ran: true,
          check_exit: 0,
          parity_exit: 1,
          failing_segment: "bun run check:ci",
          output_tail: "lint:strict failed",
        },
      ],
    },
    { parity_check: "bun run check:ci", max_rounds: 1 },
  );

  expect(result.ok).toBe(false);
  expect(result.green).toBe(false);
  expect(result.rounds[0]?.check_verify_status).toBe("failed");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[0]?.ci_parity).toBe(false);
  expect(result.ci_parity).toBe(false);
});

test("worker PASS with check_exit 0 and parity_exit 0 is green with ci_parity true", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0, parity_exit: 0 }],
    },
    { parity_check: "bun run check:ci" },
  );

  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  expect(result.rounds[0]?.ci_parity).toBe(true);
  expect(result.ci_parity).toBe(true);
  const verifierStart = ctx.capturedChainStarts?.find(
    (start) => start.task_name === "verify-check",
  );
  expect(verifierStart?.message).toContain("bash -c 'bun run check:ci'");
  expect(verifierStart?.message).toContain("parity_exit");
});

test("a verifier that omits parity_exit fails closed when parity_check is set", async () => {
  const { result } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0 }],
    },
    { parity_check: "bun run check:ci", max_rounds: 1 },
  );

  expect(result.ok).toBe(false);
  expect(result.rounds[0]?.check_verify_status).toBe("failed");
  expect(result.rounds[0]?.ci_parity).toBe(false);
  expect(result.ci_parity).toBe(false);
});

test("without parity_check, round records and the result carry ci_parity false", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
    verifierResponses: [{ ran: true, check_exit: 0 }],
  });

  expect(result.green).toBe(true);
  expect(result.rounds[0]?.ci_parity).toBe(false);
  expect(result.ci_parity).toBe(false);
});

test("inputSchema rejects parity_check together with verify_check false", () => {
  const result = inputSchema.safeParse(
    baseArgs({ verify_check: false, parity_check: "bun run check:ci" }),
  );
  expect(result.success).toBe(false);
});

test("parity_check with verify_check false is rejected before any dispatch", async () => {
  const ctx = makeTestCtx({ fanoutResponses: [{ response: "CHECK_RESULT: PASS" }] });
  await expect(
    fn(
      { ...ctx, args: baseArgs({ verify_check: false, parity_check: "bun run check:ci" }) },
      emptyRecall(),
    ),
  ).rejects.toThrow(/parity_check/);
  expect(ctx.capturedChainStarts).toEqual([]);
});

test("the implementation round message carries the parity command when parity_check is set", async () => {
  const { ctx } = await runWorkflow(
    {
      fanoutResponses: [{ response: "CHECK_RESULT: PASS" }],
      verifierResponses: [{ ran: true, check_exit: 0, parity_exit: 0 }],
    },
    { parity_check: "bun run check:ci" },
  );

  const implementationStart = ctx.capturedChainStarts?.find((start) => start.task_name === "fix-1");
  expect(implementationStart?.message).toContain("bash -c 'bun run check:ci'");
});

test("a parity failure's output reaches the next round message", async () => {
  const { result, ctx } = await runWorkflow(
    {
      fanoutResponses: [
        { response: "CHECK_RESULT: PASS" },
        { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
      ],
      verifierResponses: [
        {
          ran: true,
          check_exit: 0,
          parity_exit: 1,
          failing_segment: "bun run check:ci",
          output_tail: "lint:strict failed",
        },
        { ran: true, check_exit: 0, parity_exit: 0 },
      ],
    },
    { parity_check: "bun run check:ci", max_rounds: 2 },
  );

  expect(result.ok).toBe(true);
  expect(result.green).toBe(true);
  const secondImplementation = ctx.capturedChainStarts?.find(
    (start) => start.task_name === "fix-2",
  );
  expect(secondImplementation?.message).toContain("Last failure output:");
  expect(secondImplementation?.message).toContain("lint:strict failed");
});

test("workflow stops when verifier candidate_commit does not match host SHA", async () => {
  const { result } = await runWorkflow({
    fanoutResponses: [
      { response: "CHECK_RESULT: PASS" },
      { response: "CHECK_RESULT: PASS", branchName: "feature/branch-2" },
    ],
    verifierResponses: [
      {
        ran: true,
        check_exit: 0,
        candidate_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        checkout_commit: DEFAULT_INSPECT_SHA,
      },
      { ran: true, check_exit: 0 },
    ],
  });
  expect(result.ok).toBe(true);
  expect(result.rounds[0]?.check_verify_status).toBe("failed");
  expect(result.rounds[0]?.passed).toBe(false);
  expect(result.rounds[1]?.check_verify_status).toBe("passed");
});
