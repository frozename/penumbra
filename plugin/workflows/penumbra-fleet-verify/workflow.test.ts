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
import { type FleetVerifyResult, type FleetVerifyTaskResult, fn } from "./workflow.js";
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

type TestInspection = NonNullable<Awaited<ReturnType<NonNullable<WorkflowCtx["worktreeInspect"]>>>>;

const SHA_0 = "0123456789abcdef0123456789abcdef01234567";

function shaForIndex(index: number): string {
  return `${String(index).padStart(2, "0")}${"a".repeat(38)}`;
}

function defaultInspection(handoffId: string) {
  const match = /(\d+)$/.exec(handoffId);
  const index = match ? Number(match[1]) : 0;
  const branchName = handoffId.startsWith("h-verify")
    ? `verifier/b${String(index)}`
    : handoffId.startsWith("h-v")
      ? `verifier/b${String(index)}`
      : handoffId.startsWith("h-dispatch")
        ? `feature/task-${String(index)}`
        : `feature/t${String(index)}`;
  return Promise.resolve({
    worktree: {
      handoffId,
      path: `/tmp/worktrees/${handoffId}`,
      branchName,
      storageRoot: `/tmp/worktrees/${handoffId}/.test-storage`,
      createdAt: "2026-09-12T10:00:00.000Z",
      status: "created" as const,
      worktreeMode: "symlink_mirror" as const,
    },
    diff_against_main: "diff",
    branch_log: "commit",
    head_sha: index === 0 ? SHA_0 : shaForIndex(index),
    branch_name: branchName,
    dirty: false,
    truncation: { diff_against_main: false, branch_log: false, total: false },
  });
}

function makeCtx(overrides: Partial<TestCtx> & { args?: Record<string, unknown> } = {}): TestCtx {
  return {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    cancel: async () => {},
    fileWrite: async (path: string) => path,
    worktreeInspect: defaultInspection,
    progress: () => {},
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: overrides.args ?? {},
    ...overrides,
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
    branchBase?: string | null;
    taskType?: string;
    parentHandoffId?: string | null;
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
    payload_json: { response: input.response, handoff_id: input.handoffId, agent: "executor" },
    payload_summary: "agent-response",
    origin: "dispatch",
  });
}

function makeVerifyReportJson(overrides: Record<string, unknown> = {}): string {
  const report = {
    verdict: "pass",
    target_identity: SHA_0,
    measured_exits: [
      { command: "typecheck", exit: 0 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
    test_results: null,
    tests_pass: null,
    tests_fail: null,
    files_changed: 3,
    attribution_lines: 0,
    notes: "all good",
    ...overrides,
  };
  return "```json\n" + JSON.stringify(report) + "\n```";
}

async function runSingleReport(
  reportOverrides: Record<string, unknown>,
  verifyCommands = ["typecheck", "typecheck_ratchet", "lint_strict"],
): Promise<FleetVerifyResult> {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    const response = makeVerifyReportJson(reportOverrides);
    seedResponse(db, { conversationId: "conv-v0", handoffId: "h-v0", response });
    let calls = 0;
    return (await fn(
      makeCtx({
        args: {
          tasks: [{ name: "t0", dispatch_prompt: "d" }],
          verify_commands: verifyCommands,
        },
        db: () => db,
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : { status: "completed", final_agent: "executor", response_text: response },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Loader discovery
// ---------------------------------------------------------------------------

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("penumbra-fleet-verify");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
  expect(loaded.inputSchema).toBeDefined();
});

// ---------------------------------------------------------------------------
// Input validation (delegated to schema)
// ---------------------------------------------------------------------------

test("rejects unknown top-level keys at runtime", async () => {
  const ctx = makeCtx({ args: { tasks: [{ name: "t", dispatch_prompt: "d" }], extra: "bad" } });
  await expect(fn(ctx, emptyRecall())).rejects.toThrow();
});

test("rejects empty tasks at runtime", async () => {
  const ctx = makeCtx({ args: { tasks: [] } });
  await expect(fn(ctx, emptyRecall())).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// Dispatch phase: untrustworthy never landable
// ---------------------------------------------------------------------------

test("dispatch untrustworthy result is never landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
      reliability: "bad",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });

    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        chainStart: async () =>
          Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          }),
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.dispatch.reliability_trustworthy).toBe(false);
    expect(result.results[0]?.skipped).toBe("dispatch_untrustworthy");
    expect(result.results[0]?.landable).toBe(false);
    expect(result.landable_count).toBe(0);
  } finally {
    db.close();
  }
});

test("dispatch with no branch is skipped", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: null,
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });

    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        chainStart: async () =>
          Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: null,
          }),
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.skipped).toBe("no-branch");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("dispatch without DB is untrustworthy (reliability_unverified)", async () => {
  const result = (await fn(
    makeCtx({
      args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
      chainStart: async () =>
        Response.json({
          conversation_id: "conv-0",
          handoff_id: "h-0",
          branch_name: "feature/task-0",
        }),
    }),
    emptyRecall(),
  )) as FleetVerifyResult;

  expect(result.results[0]?.dispatch.reliability_trustworthy).toBeNull();
  expect(result.results[0]?.skipped).toBe("dispatch_untrustworthy");
});

test("missing worktree inspection fails closed before verifier dispatch", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: undefined,
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("missing_worktree_inspection");
    expect(result.results[0]?.landable).toBe(false);
    expect(result.ok).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Actual-ctx binding: nullable return, foreign handle, truncation, 64-hex
// ---------------------------------------------------------------------------

const SHA_64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function fullInspection(handoffId: string, overrides: Record<string, unknown> = {}) {
  const match = /(\d+)$/.exec(handoffId);
  const index = match ? Number(match[1]) : 0;
  const branchName = handoffId.startsWith("h-verify")
    ? `verifier/b${String(index)}`
    : handoffId.startsWith("h-v")
      ? `verifier/b${String(index)}`
      : handoffId.startsWith("h-dispatch")
        ? `feature/task-${String(index)}`
        : `feature/t${String(index)}`;
  return {
    worktree: {
      handoffId,
      path: `/tmp/worktrees/${handoffId}`,
      branchName,
      storageRoot: `/tmp/worktrees/${handoffId}/.test-storage`,
      createdAt: "2026-09-12T10:00:00.000Z",
      status: "created" as const,
      worktreeMode: "symlink_mirror" as const,
    },
    diff_against_main: "diff",
    branch_log: "commit",
    head_sha: index === 0 ? SHA_0 : shaForIndex(index),
    branch_name: branchName,
    dirty: false,
    truncation: { diff_against_main: false, branch_log: false, total: false },
    ...overrides,
  };
}

function makeTrustworthyDispatchCtx(
  db: Database,
  inspectFn: (handoffId: string) => unknown,
  verifyResponse: string = makeVerifyReportJson(),
): TestCtx {
  let calls = 0;
  return makeCtx({
    args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
    db: () => db,
    worktreeInspect: ((handoffId: string) => Promise.resolve(inspectFn(handoffId))) as never,
    chainStart: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          })
        : Response.json({
            conversation_id: "conv-verify-0",
            handoff_id: "h-verify-0",
            branch_name: "verifier/b0",
          });
    },
    awaitChain: async (id: string) =>
      id === "conv-dispatch-0"
        ? { status: "completed", final_agent: "executor", response_text: "done" }
        : { status: "completed", final_agent: "executor", response_text: verifyResponse },
  });
}

test("null inspection return fails closed before verifier dispatch", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: () => Promise.resolve(null),
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("invalid_worktree_inspection");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("foreign worktree handle (handoffId mismatch) fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: () =>
          Promise.resolve(
            fullInspection("h-dispatch-0", {
              worktree: {
                handoffId: "h-foreign",
                path: "/tmp/worktrees/h-foreign",
                branchName: "feature/task-0",
                storageRoot: "/tmp/worktrees/h-foreign/.test-storage",
                createdAt: "2026-09-12T10:00:00.000Z",
                status: "created",
                worktreeMode: "symlink_mirror",
              },
            }),
          ),
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("foreign_worktree_handle");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("truncated inspection (truncation.total true) fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: () =>
          Promise.resolve(
            fullInspection("h-dispatch-0", {
              truncation: { diff_against_main: true, branch_log: false, total: true },
            }),
          ),
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("candidate_inspection_truncated");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("malformed inspection (missing truncation field) fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: (() =>
          Promise.resolve({
            worktree: {
              handoffId: "h-dispatch-0",
              path: "/tmp/worktrees/h-dispatch-0",
              branchName: "feature/task-0",
              storageRoot: "/tmp/worktrees/h-dispatch-0/.test-storage",
              createdAt: "2026-09-12T10:00:00.000Z",
              status: "created",
              worktreeMode: "symlink_mirror",
            },
            diff_against_main: "diff",
            branch_log: "commit",
            head_sha: SHA_0,
            branch_name: "feature/task-0",
            dirty: false,
          })) as never,
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("invalid_worktree_inspection");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("non-hex short head_sha fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: () =>
          Promise.resolve(fullInspection("h-dispatch-0", { head_sha: "short-not-hex" })),
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("invalid_worktree_inspection");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("worktree handle branchName inconsistent with branch_name fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: () =>
          Promise.resolve(
            fullInspection("h-dispatch-0", {
              worktree: {
                handoffId: "h-dispatch-0",
                path: "/tmp/worktrees/h-dispatch-0",
                branchName: "feature/different",
                storageRoot: "/tmp/worktrees/h-dispatch-0/.test-storage",
                createdAt: "2026-09-12T10:00:00.000Z",
                status: "created",
                worktreeMode: "symlink_mirror",
              },
            }),
          ),
        chainStart: async () => {
          calls += 1;
          return Response.json({
            conversation_id: "conv-dispatch-0",
            handoff_id: "h-dispatch-0",
            branch_name: "feature/task-0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(calls).toBe(1);
    expect(result.results[0]?.skipped).toBe("worktree_branch_name_inconsistent");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("64-hex head_sha is accepted and landable when fully trustworthy", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "h-verify-0",
      conversationId: "conv-verify-0",
      branchName: "verifier/b0",
      branchBase: SHA_64,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-verify-0",
      handoffId: "h-verify-0",
      response: makeVerifyReportJson({ target_identity: SHA_64 }),
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: (handoffId: string) =>
          Promise.resolve(fullInspection(handoffId, { head_sha: SHA_64 })),
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-dispatch-0",
                handoff_id: "h-dispatch-0",
                branch_name: "feature/task-0",
              })
            : Response.json({
                conversation_id: "conv-verify-0",
                handoff_id: "h-verify-0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-dispatch-0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({ target_identity: SHA_64 }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.candidate_before?.head_sha).toBe(SHA_64);
    expect(result.results[0]?.landable).toBe(true);
    expect(result.landable_count).toBe(1);
  } finally {
    db.close();
  }
});

test("truncated evidence after verify fails closed and is not landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "h-verify-0",
      conversationId: "conv-verify-0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-verify-0",
      handoffId: "h-verify-0",
      response: makeVerifyReportJson(),
    });
    let inspections = 0;
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: (handoffId: string) => {
          inspections += 1;
          return Promise.resolve(
            fullInspection(handoffId, {
              truncation:
                inspections === 1
                  ? { diff_against_main: false, branch_log: false, total: false }
                  : { diff_against_main: true, branch_log: false, total: true },
            }),
          );
        },
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-dispatch-0",
                handoff_id: "h-dispatch-0",
                branch_name: "feature/task-0",
              })
            : Response.json({
                conversation_id: "conv-verify-0",
                handoff_id: "h-verify-0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-dispatch-0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.validation_errors).toContain(
      "candidate_inspection_truncated_after_verify",
    );
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("foreign worktree handle after verify fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "h-verify-0",
      conversationId: "conv-verify-0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-verify-0",
      handoffId: "h-verify-0",
      response: makeVerifyReportJson(),
    });
    let inspections = 0;
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        worktreeInspect: (handoffId: string) => {
          inspections += 1;
          return Promise.resolve(
            fullInspection(handoffId, {
              worktree: {
                handoffId: inspections === 1 ? handoffId : "h-foreign",
                path: `/tmp/worktrees/${handoffId}`,
                branchName: "feature/task-0",
                storageRoot: `/tmp/worktrees/${handoffId}/.test-storage`,
                createdAt: "2026-09-12T10:00:00.000Z",
                status: "created",
                worktreeMode: "symlink_mirror",
              },
            }),
          );
        },
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-dispatch-0",
                handoff_id: "h-dispatch-0",
                branch_name: "feature/task-0",
              })
            : Response.json({
                conversation_id: "conv-verify-0",
                handoff_id: "h-verify-0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-dispatch-0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.validation_errors).toContain(
      "foreign_worktree_handle_after_verify",
    );
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("full pass: trustworthy dispatch + trustworthy verifier + valid report is landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "h-verify-0",
      conversationId: "conv-verify-0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-verify-0",
      handoffId: "h-verify-0",
      response: makeVerifyReportJson(),
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          if (callCount === 1) {
            return Response.json({
              conversation_id: "conv-dispatch-0",
              handoff_id: "h-dispatch-0",
              branch_name: "feature/task-0",
            });
          }
          return Response.json({
            conversation_id: "conv-verify-0",
            handoff_id: "h-verify-0",
            branch_name: "verifier/b0",
          });
        },
        awaitChain: async (conversationId: string) => {
          if (conversationId === "conv-dispatch-0") {
            return { status: "completed", final_agent: "executor", response_text: "done" };
          }
          return {
            status: "completed",
            final_agent: "executor",
            response_text: makeVerifyReportJson(),
          };
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.ranNothingToMain).toBe(true);
    expect(result.results[0]?.dispatch.reliability_trustworthy).toBe(true);
    expect(result.results[0]?.verify).not.toBeNull();
    expect(result.results[0]?.verify?.reliability_trustworthy).toBe(true);
    expect(result.results[0]?.verify?.report).not.toBeNull();
    expect(result.results[0]?.verify?.validation_errors).toEqual([]);
    expect(result.results[0]?.landable).toBe(true);
    expect(result.landable_count).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.landable[0]?.dispatch_handoff_id).toBe("h-dispatch-0");
    expect(result.landable[0]?.verify_handoff_id).toBe("h-verify-0");
    expect(result.landable[0]?.branch).toBe("feature/task-0");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Verifier untrustworthy PASS is not landable
// ---------------------------------------------------------------------------

test("verifier untrustworthy with schema-valid PASS report is not landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-dispatch-0",
      conversationId: "conv-dispatch-0",
      branchName: "feature/task-0",
    });
    seedResponse(db, {
      conversationId: "conv-dispatch-0",
      handoffId: "h-dispatch-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "h-verify-0",
      conversationId: "conv-verify-0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    // No DB response seeded for the verifier: the reliability classifier sees
    // responseCount === 0 and classifies it as no_agent_output (untrustworthy).
    // The awaitChain mock still returns the verify report JSON so the report is
    // parsed — proving a schema-valid PASS from an untrustworthy verifier is
    // not landable.

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "task-0", dispatch_prompt: "do work" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          if (callCount === 1) {
            return Response.json({
              conversation_id: "conv-dispatch-0",
              handoff_id: "h-dispatch-0",
              branch_name: "feature/task-0",
            });
          }
          return Response.json({
            conversation_id: "conv-verify-0",
            handoff_id: "h-verify-0",
            branch_name: "verifier/b0",
          });
        },
        awaitChain: async (conversationId: string) => {
          if (conversationId === "conv-dispatch-0") {
            return { status: "completed", final_agent: "executor", response_text: "done" };
          }
          return {
            status: "completed",
            final_agent: "executor",
            response_text: makeVerifyReportJson(),
          };
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.reliability_trustworthy).toBe(false);
    expect(result.results[0]?.verify?.report).toBeNull();
    expect(result.results[0]?.verify?.execution).toBe("unavailable");
    expect(result.results[0]?.landable).toBe(false);
    expect(result.landable_count).toBe(0);
  } finally {
    db.close();
  }
});

test("persisted trustworthy verifier with failed await lifecycle is not landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson(),
    });

    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : { status: "failed", final_agent: "executor", response_text: makeVerifyReportJson() },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.status).toBe("failed");
    expect(result.results[0]?.verify?.reliability_trustworthy).toBe(true);
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("explicit verifier verdict fail is not landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson({ verdict: "fail" }),
    });
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({ verdict: "fail" }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    expect(result.results[0]?.verify?.validation_errors).toContain("verdict_not_pass");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Measured gate contradictions
// ---------------------------------------------------------------------------

test("nonzero exit in report prevents landable despite verdict pass", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson({
        measured_exits: [
          { command: "typecheck", exit: 1 },
          { command: "typecheck_ratchet", exit: 0 },
          { command: "lint_strict", exit: 0 },
        ],
      }),
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({
                  measured_exits: [
                    { command: "typecheck", exit: 1 },
                    { command: "typecheck_ratchet", exit: 0 },
                    { command: "lint_strict", exit: 0 },
                  ],
                }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(
      result.results[0]?.verify?.validation_errors.some((e: string) =>
        e.startsWith("nonzero_exit"),
      ),
    ).toBe(true);
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("missing exit in report prevents landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson({
        measured_exits: [
          { command: "typecheck", exit: 0 },
          { command: "typecheck_ratchet", exit: 0 },
        ],
      }),
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({
                  measured_exits: [
                    { command: "typecheck", exit: 0 },
                    { command: "typecheck_ratchet", exit: 0 },
                  ],
                }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(
      result.results[0]?.verify?.validation_errors.some((e: string) =>
        e.startsWith("missing_exit:lint_strict"),
      ),
    ).toBe(true);
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("DB producer-consumer rejects duplicate, unknown, and skipped measured exits", async () => {
  const cases = [
    {
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "typecheck", exit: 1 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
      ],
      error: "duplicate_exit:typecheck",
    },
    {
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
        { command: "test_core", exit: 0 },
      ],
      error: "unknown_exit:test_core",
    },
    {
      measured_exits: [
        { command: "typecheck", exit: -1 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
      ],
      error: "skipped_exit:typecheck",
    },
  ];
  for (const item of cases) {
    const result = await runSingleReport({ measured_exits: item.measured_exits });
    expect(result.results[0]?.verify?.validation_errors).toContain(item.error);
    expect(result.results[0]?.landable).toBe(false);
  }
});

test("DB producer-consumer requires a real positive receipt for every requested test slice", async () => {
  const synthetic = await runSingleReport(
    {
      measured_exits: [{ command: "test_core", exit: 0 }],
      test_results: [{ command: "test_core", tests_pass: 0, tests_fail: 0 }],
      tests_pass: 0,
      tests_fail: 0,
    },
    ["test_core"],
  );
  expect(synthetic.results[0]?.verify?.validation_errors).toContain("tests_not_run:test_core");
  expect(synthetic.results[0]?.landable).toBe(false);

  const measured = await runSingleReport(
    {
      measured_exits: [{ command: "test_core", exit: 0 }],
      test_results: [{ command: "test_core", tests_pass: 12, tests_fail: 0 }],
      tests_pass: 12,
      tests_fail: 0,
    },
    ["test_core"],
  );
  expect(measured.results[0]?.verify?.validation_errors).toEqual([]);
  expect(measured.results[0]?.landable).toBe(true);
});

test("target identity mismatch prevents landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson({ target_identity: "wrong-branch" }),
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({
                  target_identity: "ffffffffffffffffffffffffffffffffffffffff",
                }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.validation_errors).toContain("target_identity_mismatch");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("attribution_lines > 0 prevents landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson({ attribution_lines: 2 }),
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson({ attribution_lines: 2 }),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.validation_errors).toContain("attribution_lines_gt_0");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Malformed structured report
// ---------------------------------------------------------------------------

test("malformed structured report (no json block) prevents landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: "I could not verify",
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : { status: "completed", final_agent: "executor", response_text: "I could not verify" },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.parse_error).toBe("no_json_block");
    expect(result.results[0]?.verify?.report).toBeNull();
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("invalid json in report prevents landable", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: "```json\n{bad json}\n```",
    });

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: "```json\n{bad json}\n```",
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results[0]?.verify?.parse_error).toBe("invalid_json");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Deterministic ordered mapping
// ---------------------------------------------------------------------------

test("preserves input order with multiple tasks completing out of order", async () => {
  const db = freshDb();
  try {
    for (let i = 0; i < 3; i++) {
      seedHandoff(db, {
        handoffId: `h-d${i}`,
        conversationId: `conv-d${i}`,
        branchName: `feature/t${i}`,
        ts: `2026-09-12T10:00:${String(i).padStart(2, "0")}.000Z`,
      });
      seedResponse(db, { conversationId: `conv-d${i}`, handoffId: `h-d${i}`, response: "done" });
      seedHandoff(db, {
        handoffId: `h-v${i}`,
        conversationId: `conv-v${i}`,
        branchName: `verifier/b${i}`,
        branchBase: i === 0 ? SHA_0 : shaForIndex(i),
        taskType: "review_adversarial",
        ts: `2026-09-12T10:01:${String(i).padStart(2, "0")}.000Z`,
      });
      seedResponse(db, {
        conversationId: `conv-v${i}`,
        handoffId: `h-v${i}`,
        response: makeVerifyReportJson({ target_identity: i === 0 ? SHA_0 : shaForIndex(i) }),
      });
    }

    let callCount = 0;
    const result = (await fn(
      makeCtx({
        args: {
          tasks: [
            { name: "alpha", dispatch_prompt: "d" },
            { name: "beta", dispatch_prompt: "d" },
            { name: "gamma", dispatch_prompt: "d" },
          ],
        },
        db: () => db,
        chainStart: async () => {
          callCount += 1;
          const phase = callCount <= 3 ? "d" : "v";
          const idx = phase === "d" ? callCount - 1 : callCount - 4;
          return Response.json({
            conversation_id: `conv-${phase}${idx}`,
            handoff_id: `h-${phase}${idx}`,
            branch_name: phase === "d" ? `feature/t${idx}` : `verifier/b${idx}`,
          });
        },
        awaitChain: async (id: string) => {
          if (id.startsWith("conv-d"))
            return { status: "completed", final_agent: "executor", response_text: "done" };
          const idx = Number(id.slice(-1));
          return {
            status: "completed",
            final_agent: "executor",
            response_text: makeVerifyReportJson({
              target_identity: idx === 0 ? SHA_0 : shaForIndex(idx),
            }),
          };
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(result.results.map((r: FleetVerifyTaskResult) => r.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result.results.map((r: FleetVerifyTaskResult) => r.index)).toEqual([0, 1, 2]);
    expect(result.landable_count).toBe(3);
  } finally {
    db.close();
  }
});

test("uses the latest matching hop as the authoritative candidate", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "h-root",
      conversationId: "conv-d0",
      branchName: "feature/root",
      ts: "2026-09-12T10:00:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "h-latest",
      conversationId: "conv-d0",
      branchName: "feature/latest",
      parentHandoffId: "h-root",
      message: "[silent-failure-retry] retry",
      ts: "2026-09-12T10:00:20.000Z",
    });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-latest", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson(),
    });
    const inspected: string[] = [];
    const requests: ChainStartRequest[] = [];
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        worktreeInspect: async (handoffId: string) => {
          inspected.push(handoffId);
          if (handoffId === "h-v0") return strictBindingInspection(handoffId);
          return {
            worktree: {
              handoffId,
              path: "/tmp/worktrees/h-latest",
              branchName: "feature/latest",
              storageRoot: "/tmp/worktrees/h-latest/.test-storage",
              createdAt: "2026-09-12T10:00:00.000Z",
              status: "created" as const,
              worktreeMode: "symlink_mirror" as const,
            },
            diff_against_main: "diff",
            branch_log: "commit",
            head_sha: SHA_0,
            branch_name: "feature/latest",
            dirty: false,
            truncation: { diff_against_main: false, branch_log: false, total: false },
          };
        },
        chainStart: async (input: ChainStartRequest) => {
          requests.push(input);
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-root",
                branch_name: "feature/root",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;

    expect(inspected).toEqual(["h-latest", "h-v0", "h-latest"]);
    expect(requests[1]?.branch_base).toBe(SHA_0);
    expect(result.results[0]?.dispatch.branch_name).toBe("feature/latest");
    expect(result.results[0]?.dispatch.latest_handoff_id).toBe("h-latest");
    expect(result.results[0]?.landable).toBe(true);
  } finally {
    db.close();
  }
});

test("candidate movement after verification fails closed", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson(),
    });
    let inspections = 0;
    let calls = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        worktreeInspect: async (handoffId: string) => {
          inspections += 1;
          if (handoffId === "h-v0") return strictBindingInspection(handoffId);
          return {
            worktree: {
              handoffId,
              path: "/tmp/worktrees/h-d0",
              branchName: "feature/t0",
              storageRoot: "/tmp/worktrees/h-d0/.test-storage",
              createdAt: "2026-09-12T10:00:00.000Z",
              status: "created" as const,
              worktreeMode: "symlink_mirror" as const,
            },
            diff_against_main: "diff",
            branch_log: "commit",
            head_sha: inspections === 1 ? SHA_0 : "f".repeat(40),
            branch_name: "feature/t0",
            dirty: false,
            truncation: { diff_against_main: false, branch_log: false, total: false },
          };
        },
        chainStart: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    expect(result.results[0]?.verify?.validation_errors).toContain("candidate_moved_after_verify");
    expect(result.results[0]?.landable).toBe(false);
  } finally {
    db.close();
  }
});

test("artifact write failure and wrong receipt prevent success and landability", async () => {
  for (const fileWrite of [
    async () => {
      throw new Error("write failed");
    },
    async () => "/tmp/wrong-receipt.json",
  ]) {
    const db = freshDb();
    try {
      seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
      seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
      seedHandoff(db, {
        handoffId: "h-v0",
        conversationId: "conv-v0",
        branchName: "verifier/b0",
        branchBase: SHA_0,
        taskType: "review_adversarial",
        ts: "2026-09-12T10:01:00.000Z",
      });
      seedResponse(db, {
        conversationId: "conv-v0",
        handoffId: "h-v0",
        response: makeVerifyReportJson(),
      });
      let calls = 0;
      const result = (await fn(
        makeCtx({
          args: { tasks: [{ name: "t0", dispatch_prompt: "d" }], out_dir: "/tmp/work/reports" },
          db: () => db,
          fileWrite,
          chainStart: async () => {
            calls += 1;
            return calls === 1
              ? Response.json({
                  conversation_id: "conv-d0",
                  handoff_id: "h-d0",
                  branch_name: "feature/t0",
                })
              : Response.json({
                  conversation_id: "conv-v0",
                  handoff_id: "h-v0",
                  branch_name: "verifier/b0",
                });
          },
          awaitChain: async (id: string) =>
            id === "conv-d0"
              ? { status: "completed", final_agent: "executor", response_text: "done" }
              : {
                  status: "completed",
                  final_agent: "executor",
                  response_text: makeVerifyReportJson(),
                },
        }),
        emptyRecall(),
      )) as FleetVerifyResult;
      expect(result.ok).toBe(false);
      expect(result.landable_count).toBe(0);
      expect(result.results[0]?.landable).toBe(false);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Verify dispatch uses isolated worktree with branch_base = candidate branch
// ---------------------------------------------------------------------------

test("verify dispatch uses immutable candidate SHA in a separate isolated worktree", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson(),
    });

    const captured: ChainStartRequest[] = [];
    let callCount = 0;
    await fn(
      makeCtx({
        args: {
          tasks: [
            {
              name: "x".repeat(120),
              dispatch_prompt: "d",
              agent: "executor",
              task_class: "TRIVIAL",
              task_type: "docs_mechanical",
              branch_base: "main",
              branch_type: "feature",
              isolated_install: false,
            },
          ],
          project_id: "penumbra",
        },
        db: () => db,
        chainStart: async (input: ChainStartRequest) => {
          captured.push(input);
          callCount += 1;
          return callCount === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    );

    // Verify dispatch (second call)
    const dispatchReq = captured[0]!;
    expect(dispatchReq).toEqual(
      expect.objectContaining({
        initial_agent: "executor",
        task_class: "TRIVIAL",
        task_type: "docs_mechanical",
        branch_base: "main",
        branch_type: "feature",
        isolated_install: false,
        project_id: "penumbra",
      }),
    );
    const verifyReq = captured[1]!;
    expect(verifyReq.task_type).toBe("review_adversarial");
    expect(verifyReq.use_worktree).toBe(true);
    expect(verifyReq.branch_base).toBe(SHA_0);
    expect(verifyReq.isolated_install).toBe(true);
    expect(verifyReq.project_id).toBe("penumbra");
    expect(verifyReq.task_name?.length).toBeLessThanOrEqual(120);
    expect(verifyReq.task_name).toMatch(/^verify:0:/);
    // Verifier branch is separate from candidate branch
    expect(verifyReq.branch_base).not.toBe(verifyReq.task_name);
  } finally {
    db.close();
  }
});

test("verify dispatch is explicitly bounded to one hop", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: "h-v0",
      response: makeVerifyReportJson(),
    });

    const captured: ChainStartRequest[] = [];
    await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        chainStart: async (input: ChainStartRequest) => {
          captured.push(input);
          return captured.length === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : {
                status: "completed",
                final_agent: "executor",
                response_text: makeVerifyReportJson(),
              },
      }),
      emptyRecall(),
    );

    expect(captured[1]).toEqual(
      expect.objectContaining({
        initial_agent: "executor",
        dispatch_kind: "workflow",
        task_type: "review_adversarial",
        use_worktree: true,
        branch_base: SHA_0,
        isolated_install: true,
        project_id: "penumbra",
        max_hops: 1,
      }),
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// ranNothingToMain is literal true
// ---------------------------------------------------------------------------

test("ranNothingToMain is literal true even when all tasks fail", async () => {
  const result = (await fn(
    makeCtx({
      args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
      chainStart: async () => Response.json({ error: { code: "bad" } }, 400),
    }),
    emptyRecall(),
  )) as FleetVerifyResult;

  expect(result.ranNothingToMain).toStrictEqual(true);
  expect(result.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// No in-process execution structural tripwire
// ---------------------------------------------------------------------------

test("workflow source does not import or call in-process execution primitives", async () => {
  const source = await Bun.file(join(import.meta.dirname, "workflow.ts")).text();
  // Check for execution API patterns — these should never appear in the workflow runtime
  const executionPatterns = [
    /import[^;]*child_process/,
    /import[^;]*bun:sqlite/,
    /Bun\.\$/,
    /Bun\.spawn/,
    /Bun\.spawnSync/,
    /execSync/,
    /spawnSync/,
  ];
  for (const pattern of executionPatterns) {
    expect(pattern.test(source)).toBe(false);
  }
  // Verify it does import runFanout (the only dispatch path)
  expect(source).toContain("runFanout");
});

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

test("registry loads penumbra-fleet-verify with zero errors", async () => {
  const { buildRegistry } = await import("@penumbra/workflows");
  const repoRoot = join(import.meta.dir, "../../..");
  const reg = await buildRegistry({
    playbooksDir: join(repoRoot, "plugin/playbooks"),
    workflowsDir: join(repoRoot, "plugin/workflows"),
  });
  expect(reg.errors).toEqual([]);
  expect(reg.get("penumbra-fleet-verify")?.name).toBe("penumbra-fleet-verify");
});

function strictBindingInspection(
  handoffId: string,
  overrides: Record<string, unknown> = {},
): TestInspection {
  const verifier = handoffId.startsWith("h-v");
  const branchName = verifier ? "verifier/b0" : "feature/t0";
  return {
    worktree: {
      handoffId,
      path: `/tmp/worktrees/${handoffId}`,
      branchName,
      storageRoot: `/tmp/worktrees/${handoffId}/.test-storage`,
      createdAt: "2026-09-12T10:00:00.000Z",
      status: "created",
      projectId: "penumbra",
      worktreeMode: "symlink_mirror",
    },
    diff_against_main: "diff",
    branch_log: "commit",
    head_sha: SHA_0,
    branch_name: branchName,
    dirty: false,
    truncation: { diff_against_main: false, branch_log: false, total: false },
    ...overrides,
  };
}

async function runCorrectionScenario(
  options: {
    verifierBranchBase?: string;
    verifierChildStatus?: "completed" | "failed";
    verifierIncomplete?: boolean;
    inspect?: (handoffId: string, call: number) => unknown;
  } = {},
): Promise<{
  result: FleetVerifyResult;
  inspected: string[];
  requests: ChainStartRequest[];
}> {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    seedHandoff(db, {
      handoffId: "h-v0",
      conversationId: "conv-v0",
      branchName: "verifier/b0",
      branchBase: options.verifierBranchBase ?? SHA_0,
      taskType: "review_adversarial",
      ts: "2026-09-12T10:01:00.000Z",
    });
    let verifierResponseHandoff = "h-v0";
    if (options.verifierIncomplete) {
      new T0Writer(db).write({
        event_id: "retry-without-verifier-handoff",
        ts: "2026-09-12T10:01:30.000Z",
        ingest_ts: "2026-09-12T10:01:30.000Z",
        source: "agentchat",
        source_detail: "worker",
        project_id: "penumbra",
        user_id: "test",
        machine_id: "test",
        session_id: "conv-v0",
        event_type: "user-prompt",
        lane: "cli-subscription",
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: null,
        request_id: null,
        payload_json: {
          prompt: "[silent-failure-retry] retry_of=h-v0 prior_agent=executor\n\nretry",
        },
        payload_summary: "user-prompt",
        origin: "dispatch",
      });
    }
    if (options.verifierChildStatus) {
      verifierResponseHandoff = "h-v1";
      seedHandoff(db, {
        handoffId: "h-v1",
        conversationId: "conv-v0",
        branchName: "verifier/b0",
        branchBase: options.verifierBranchBase ?? SHA_0,
        taskType: "review_adversarial",
        parentHandoffId: "h-v0",
        status: options.verifierChildStatus,
        ts: "2026-09-12T10:02:00.000Z",
      });
    }
    const response = makeVerifyReportJson();
    seedResponse(db, {
      conversationId: "conv-v0",
      handoffId: verifierResponseHandoff,
      response,
    });

    const inspected: string[] = [];
    const requests: ChainStartRequest[] = [];
    let inspectionCall = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        worktreeInspect: ((handoffId: string) => {
          inspected.push(handoffId);
          inspectionCall += 1;
          return Promise.resolve(
            options.inspect
              ? options.inspect(handoffId, inspectionCall)
              : strictBindingInspection(handoffId),
          );
        }) as never,
        chainStart: async (request: ChainStartRequest) => {
          requests.push(request);
          return requests.length === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({
                conversation_id: "conv-v0",
                handoff_id: "h-v0",
                branch_name: "verifier/b0",
              });
        },
        awaitChain: async (id: string) =>
          id === "conv-d0"
            ? { status: "completed", final_agent: "executor", response_text: "done" }
            : { status: "completed", final_agent: "executor", response_text: response },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    return { result, inspected, requests };
  } finally {
    db.close();
  }
}

test("leaf truncation fails closed even when truncation.total is false", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    let starts = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        worktreeInspect: () =>
          Promise.resolve(
            strictBindingInspection("h-d0", {
              truncation: { diff_against_main: true, branch_log: false, total: false },
            }),
          ),
        chainStart: async () => {
          starts += 1;
          return Response.json({
            conversation_id: "conv-d0",
            handoff_id: "h-d0",
            branch_name: "feature/t0",
          });
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    expect(starts).toBe(1);
    expect(result.results[0]?.skipped).toBe("candidate_inspection_truncated");
  } finally {
    db.close();
  }
});

test("non-created and foreign-project worktree handles fail before verifier dispatch", async () => {
  for (const mutation of [
    { status: "merged", expected: "candidate_worktree_not_created" },
    { projectId: "other-project", expected: "candidate_project_mismatch" },
  ] as const) {
    const db = freshDb();
    try {
      seedHandoff(db, {
        handoffId: "h-d0",
        conversationId: "conv-d0",
        branchName: "feature/t0",
      });
      seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
      let starts = 0;
      const base = strictBindingInspection("h-d0");
      const result = (await fn(
        makeCtx({
          args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
          db: () => db,
          worktreeInspect: () =>
            Promise.resolve({
              ...base,
              worktree: { ...base.worktree, ...mutation },
            }),
          chainStart: async () => {
            starts += 1;
            return Response.json({
              conversation_id: "conv-d0",
              handoff_id: "h-d0",
              branch_name: "feature/t0",
            });
          },
        }),
        emptyRecall(),
      )) as FleetVerifyResult;
      expect(starts).toBe(1);
      expect(result.results[0]?.skipped).toBe(mutation.expected);
    } finally {
      db.close();
    }
  }
});

test("differing project_id is rejected before any dispatch", async () => {
  let starts = 0;
  await expect(
    fn(
      makeCtx({
        args: {
          tasks: [{ name: "t0", dispatch_prompt: "d" }],
          project_id: "other-project",
        },
        chainStart: async () => {
          starts += 1;
          return Response.json({});
        },
      }),
      emptyRecall(),
    ),
  ).rejects.toThrow("project_id must match the workflow context project");
  expect(starts).toBe(0);
});

test("unsupported repo and caller_cwd overrides are rejected before dispatch", async () => {
  for (const key of ["repo", "caller_cwd"] as const) {
    let starts = 0;
    await expect(
      fn(
        makeCtx({
          args: { tasks: [{ name: "t0", dispatch_prompt: "d" }], [key]: "/tmp/other" },
          chainStart: async () => {
            starts += 1;
            return Response.json({});
          },
        }),
        emptyRecall(),
      ),
    ).rejects.toThrow();
    expect(starts).toBe(0);
  }
});

test("host inspection binds the authoritative verifier checkout HEAD and branch", async () => {
  const { result, inspected } = await runCorrectionScenario({
    inspect: (handoffId) =>
      handoffId === "h-v0"
        ? strictBindingInspection(handoffId, { head_sha: "f".repeat(40) })
        : strictBindingInspection(handoffId),
  });
  expect(inspected).toEqual(["h-d0", "h-v0", "h-d0"]);
  expect(result.results[0]?.verify?.inspection_error).toBe("verifier_head_mismatch");
  expect(result.results[0]?.landable).toBe(false);
});

test("persisted verifier root branch_base must equal the candidate host SHA", async () => {
  const { result } = await runCorrectionScenario({ verifierBranchBase: "f".repeat(40) });
  expect(result.results[0]?.verify?.validation_errors).toContain(
    "verifier_root_branch_base_mismatch",
  );
  expect(result.results[0]?.landable).toBe(false);
});

test("failed latest verifier lineage cannot be accepted through trustworthy root evidence", async () => {
  const { result } = await runCorrectionScenario({ verifierChildStatus: "failed" });
  expect(result.results[0]?.verify?.reliability_trustworthy).toBe(true);
  expect(result.results[0]?.verify?.latest_reliability_trustworthy).toBe(true);
  expect(result.results[0]?.verify?.execution).toBe("unavailable");
  expect(result.results[0]?.landable).toBe(false);
});

test("incomplete latest verifier lineage is unavailable and never parsed as a report", async () => {
  const { result } = await runCorrectionScenario({ verifierIncomplete: true });
  expect(result.results[0]?.verify?.hops_incomplete).toBe(true);
  expect(result.results[0]?.verify?.execution).toBe("unavailable");
  expect(result.results[0]?.verify?.report).toBeNull();
  expect(result.results[0]?.verify?.parse_error).toBeNull();
  expect(result.results[0]?.landable).toBe(false);
});

test("root verifier response is not relabeled as completed latest-hop testimony", async () => {
  const { result } = await runCorrectionScenario({ verifierChildStatus: "completed" });
  expect(result.results[0]?.verify?.latest_reliability_trustworthy).toBe(true);
  expect(result.results[0]?.verify?.response_handoff_id).toBe("h-v0");
  expect(result.results[0]?.verify?.latest_handoff_id).toBe("h-v1");
  expect(result.results[0]?.verify?.report).toBeNull();
  expect(result.results[0]?.verify?.validation_errors).toContain(
    "verifier_response_not_bound_to_latest_hop",
  );
  expect(result.results[0]?.landable).toBe(false);
});

test("deadline exhaustion before verifier start is retained as not_run evidence", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    let expired = false;
    let starts = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        deadline: () => ({ remaining_ms: expired ? 0 : 30_000, expired }),
        worktreeInspect: (handoffId: string) => Promise.resolve(strictBindingInspection(handoffId)),
        chainStart: async () => {
          starts += 1;
          return Response.json({
            conversation_id: "conv-d0",
            handoff_id: "h-d0",
            branch_name: "feature/t0",
          });
        },
        awaitChain: async () => {
          expired = true;
          return { status: "completed", final_agent: "executor", response_text: "done" };
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    expect(starts).toBe(1);
    expect(result.results[0]?.verify?.execution).toBe("not_run");
    expect(result.results[0]?.verify?.error_summary).toBe("run_deadline_expired");
    expect(result.results[0]?.verify?.parse_error).toBeNull();
    expect(result.results[0]?.skipped).toBe("run_deadline_expired");
  } finally {
    db.close();
  }
});

test("candidate dirtiness and post-handle branch mismatch are rejected after verification", async () => {
  for (const scenario of ["dirty", "handle_branch"] as const) {
    const { result } = await runCorrectionScenario({
      inspect: (handoffId, call) => {
        const base = strictBindingInspection(handoffId);
        if (call !== 3) return base;
        if (scenario === "dirty") return { ...base, dirty: true };
        return {
          ...base,
          worktree: { ...base.worktree, branchName: "feature/foreign" },
        };
      },
    });
    expect(result.results[0]?.candidate_after_error).toBe(
      scenario === "dirty"
        ? "candidate_dirty_after_verify"
        : "candidate_after_worktree_branch_mismatch",
    );
    expect(result.results[0]?.landable).toBe(false);
  }
});

test("null verifier inspection is retained as unavailable evidence", async () => {
  const { result } = await runCorrectionScenario({
    inspect: (handoffId) => (handoffId === "h-v0" ? null : strictBindingInspection(handoffId)),
  });
  expect(result.results[0]?.verify?.execution).toBe("completed");
  expect(result.results[0]?.verify?.inspection).toBeNull();
  expect(result.results[0]?.verify?.inspection_error).toBe("invalid_verifier_worktree_inspection");
  expect(result.results[0]?.landable).toBe(false);
});

test("verifier leaf truncation and inspection failure retain unavailable evidence", async () => {
  for (const scenario of ["leaf_truncated", "throws"] as const) {
    const { result } = await runCorrectionScenario({
      inspect: (handoffId) => {
        if (handoffId !== "h-v0") return strictBindingInspection(handoffId);
        if (scenario === "throws") throw new Error("inspection failed");
        return strictBindingInspection(handoffId, {
          truncation: { diff_against_main: false, branch_log: true, total: false },
        });
      },
    });
    expect(result.results[0]?.verify?.inspection).toBeNull();
    expect(result.results[0]?.verify?.inspection_error).toBe(
      scenario === "throws"
        ? "verifier_worktree_inspection_failed"
        : "verifier_inspection_truncated",
    );
    expect(result.results[0]?.landable).toBe(false);
  }
});

test("verifier start failure retains the real not_run error without parse synthesis", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "h-d0", conversationId: "conv-d0", branchName: "feature/t0" });
    seedResponse(db, { conversationId: "conv-d0", handoffId: "h-d0", response: "done" });
    let starts = 0;
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ name: "t0", dispatch_prompt: "d" }] },
        db: () => db,
        worktreeInspect: (handoffId: string) => Promise.resolve(strictBindingInspection(handoffId)),
        chainStart: async () => {
          starts += 1;
          return starts === 1
            ? Response.json({
                conversation_id: "conv-d0",
                handoff_id: "h-d0",
                branch_name: "feature/t0",
              })
            : Response.json({ error: { code: "bad_request" } }, 400);
        },
      }),
      emptyRecall(),
    )) as FleetVerifyResult;
    expect(result.results[0]?.verify?.execution).toBe("not_run");
    expect(result.results[0]?.verify?.error_summary).toBe("chain_start_failed");
    expect(result.results[0]?.verify?.parse_error).toBeNull();
    expect(result.results[0]?.skipped).toBe("chain_start_failed");
  } finally {
    db.close();
  }
});
