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
import { type FanoutWorkflowResult, fn, inputSchema } from "./workflow.js";

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
    parentHandoffId?: string | null;
    branchBase?: string | null;
    message?: string;
    status?: "completed" | "failed";
    reliability?: "good" | "bad";
    taskType?: "implement_small" | "review_adversarial";
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
    chain_task_type: input.taskType ?? "review_adversarial",
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

function chainStartForIndex(index: number, branchName: string | null): Response {
  return Response.json({
    conversation_id: `conversation-${index}`,
    handoff_id: `handoff-${index}`,
    branch_name: branchName,
  });
}

async function runFanoutWorkflow(
  overrides: Partial<TestCtx> & { args?: Record<string, unknown> } = {},
): Promise<FanoutWorkflowResult> {
  return (await fn(makeCtx(overrides), emptyRecall())) as FanoutWorkflowResult;
}

// ---------------------------------------------------------------------------
// Loader discovery
// ---------------------------------------------------------------------------

test("loads through the registered TS loader with a valid ts-function spec", async () => {
  const loaded = await loadTsWorkflow(join(import.meta.dirname, "workflow.ts"));
  expect(loaded.spec.name).toBe("penumbra-fanout");
  expect(loaded.spec.run.kind).toBe("ts-function");
  expect(typeof loaded.fn).toBe("function");
  expect(loaded.inputSchema).toBeDefined();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("rejects unknown top-level keys", () => {
  const result = inputSchema.safeParse({
    tasks: [{ message: "work" }],
    agentType: "penumbra-dispatcher",
  });
  expect(result.success).toBe(false);
});

test("rejects unknown task keys", () => {
  const result = inputSchema.safeParse({
    tasks: [{ message: "work", dispatcherModel: "sonnet" }],
  });
  expect(result.success).toBe(false);
});

test("rejects empty tasks array", () => {
  const result = inputSchema.safeParse({ tasks: [] });
  expect(result.success).toBe(false);
});

test("rejects tasks without a message", () => {
  const result = inputSchema.safeParse({ tasks: [{ label: "no-message" }] });
  expect(result.success).toBe(false);
});

test("accepts all supported fields including explicit false values", () => {
  const result = inputSchema.safeParse({
    tasks: [
      {
        message: "work",
        use_worktree: false,
        isolated_install: false,
        tool_free: false,
        trust_mode: "config",
      },
    ],
    defaults: { use_worktree: false, isolated_install: false, tool_free: false },
  });
  expect(result.success).toBe(true);
});

// ---------------------------------------------------------------------------
// Dispatch contract
// ---------------------------------------------------------------------------

test("passes every supported chain field and preserves explicit false values", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [
        {
          message: "perform task",
          initial_agent: "pinned-seat",
          task_name: "named task",
          branch_type: "feature",
          task_class: "BOUNDARY",
          task_type: "review_adversarial",
          trust_mode: "config",
          use_worktree: false,
          isolated_install: false,
          tool_free: false,
          max_hops: 3,
          project_id: "task-project",
          parent_handoff_id: "parent-1",
          branch_base: "base-branch",
        },
      ],
    },
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(0, null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured[0]).toEqual({
    initial_agent: "pinned-seat",
    message: "perform task",
    task_name: "named task",
    branch_type: "feature",
    task_class: "BOUNDARY",
    task_type: "review_adversarial",
    trust_mode: "config",
    use_worktree: false,
    isolated_install: false,
    tool_free: false,
    max_hops: 3,
    project_id: "task-project",
    parent_handoff_id: "parent-1",
    branch_base: "base-branch",
    dispatch_kind: "workflow",
  });
});

test("defaults routing to executor without consulting global configuration", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    args: { tasks: [{ message: "work" }] },
    config: { default_roles: { executor: "global-seat" } },
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(0, null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured[0]?.initial_agent).toBe("executor");
  expect(captured[0]?.project_id).toBe("penumbra");
});

test("forwards shared floor defaults when defaults are omitted", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    args: { tasks: [{ message: "work" }] },
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(0, null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured[0]).toMatchObject({
    initial_agent: "executor",
    task_name: "task-0",
    task_class: "STANDARD",
    task_type: "unknown",
    trust_mode: "all",
    use_worktree: true,
    max_hops: 8,
    project_id: "penumbra",
    dispatch_kind: "workflow",
  });
});

test("resolves label/name/title aliases for task_name", async () => {
  const captured: ChainStartRequest[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [
        { message: "one", name: "from-name" },
        { message: "two", title: "from-title" },
        { message: "three", label: "from-label" },
        { message: "four", task_name: "explicit" },
      ],
    },
    chainStart: async (input) => {
      captured.push(input);
      return chainStartForIndex(captured.length - 1, null);
    },
  });

  await fn(ctx, emptyRecall());

  expect(captured.map((r) => r.task_name)).toEqual([
    "from-name",
    "from-title",
    "from-label",
    "explicit",
  ]);
});

test("forwards top-level timeout_ms as default when defaults.timeout_ms is absent", async () => {
  const awaitCalls: { opts?: { timeoutMs?: number } }[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work" }],
      timeout_ms: 123_456,
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async (_id, opts) => {
      awaitCalls.push({ opts });
      return { status: "completed", final_agent: "executor", response_text: "done" };
    },
  });

  await fn(ctx, emptyRecall());

  expect(awaitCalls[0]?.opts?.timeoutMs).toBe(123_456);
});

test("per-task timeout_ms overrides top-level timeout_ms", async () => {
  const awaitCalls: { opts?: { timeoutMs?: number } }[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work", timeout_ms: 654_321 }],
      timeout_ms: 123_456,
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async (_id, opts) => {
      awaitCalls.push({ opts });
      return { status: "completed", final_agent: "executor", response_text: "done" };
    },
  });

  await fn(ctx, emptyRecall());

  expect(awaitCalls[0]?.opts?.timeoutMs).toBe(654_321);
});

// ---------------------------------------------------------------------------
// Fail-closed reliability
// ---------------------------------------------------------------------------

test("fails truthfully without chainStart or project scope", async () => {
  const noCapability = await runFanoutWorkflow({
    args: { tasks: [{ message: "work" }] },
    chainStart: undefined,
  });
  const noScope = await runFanoutWorkflow({
    args: { tasks: [{ message: "work" }] },
    project: "",
    chainStart: async () => chainStartForIndex(0, null),
  });

  expect(noCapability.results[0]?.error_summary).toBe("chain_start_unavailable");
  expect(noScope.results[0]?.error_summary).toBe("project_scope_required");
});

test("fails closed when DB access is absent (reliability_unverified)", async () => {
  const result = await runFanoutWorkflow({
    args: { tasks: [{ message: "work" }] },
    chainStart: async () => chainStartForIndex(0, null),
  });

  expect(result.results[0]?.ok).toBe(false);
  expect(result.results[0]?.reliability_trustworthy).toBeNull();
  expect(result.results[0]?.error_summary).toBe("reliability_unverified");
});

test("fails closed when reliability is untrustworthy", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "handoff-0",
      conversationId: "conversation-0",
      branchName: "feature/probe-0",
      reliability: "bad",
      taskType: "implement_small",
    });
    seedResponse(db, {
      conversationId: "conversation-0",
      handoffId: "handoff-0",
      response: "done",
    });

    const result = await runFanoutWorkflow({
      args: { tasks: [{ message: "work" }] },
      db: () => db,
      chainStart: async () => chainStartForIndex(0, null),
    });

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reliability_trustworthy).toBe(false);
    expect(result.results[0]?.error_summary).toBe("reliability_untrustworthy");
  } finally {
    db.close();
  }
});

test("fails closed when root response is missing", async () => {
  const result = await runFanoutWorkflow({
    args: { tasks: [{ message: "work" }] },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: null,
    }),
  });

  expect(result.results[0]?.ok).toBe(false);
  expect(result.results[0]?.error_summary).toBe("missing_response");
});

// ---------------------------------------------------------------------------
// Two-hop evidence
// ---------------------------------------------------------------------------

test("reads two-hop root/latest evidence with different branches", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "root-h",
      conversationId: "conversation-0",
      branchName: "feature/root-branch",
      branchBase: "main",
    });
    seedResponse(db, {
      conversationId: "conversation-0",
      handoffId: "root-h",
      response: "authoritative root output",
    });
    seedHandoff(db, {
      handoffId: "child-h",
      conversationId: "conversation-0",
      branchName: "feature/child-branch",
      parentHandoffId: "root-h",
      branchBase: "feature/root-branch",
      message: "[silent-failure-retry] try again",
      status: "failed",
      ts: "2026-09-12T10:01:00.000Z",
    });

    const result = await runFanoutWorkflow({
      args: { tasks: [{ message: "review" }] },
      db: () => db,
      chainStart: async () =>
        Response.json({
          conversation_id: "conversation-0",
          handoff_id: "root-h",
          branch_name: "stale-provisional",
        }),
      awaitChain: async () => ({
        status: "completed",
        final_agent: "root-agent",
        response_text: "authoritative root output",
      }),
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      handoff_id: "root-h",
      root_handoff_id: "root-h",
      latest_handoff_id: "child-h",
      branch_name: "feature/root-branch",
      branch_base: "main",
      hop_count: 2,
      extra_hops: 1,
    });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Task label/index ordering
// ---------------------------------------------------------------------------

test("preserves input order when sibling waits complete out of order", async () => {
  const completionOrder: string[] = [];
  let next = 0;
  const ctx = makeCtx({
    args: {
      tasks: [
        { label: "first", message: "one" },
        { label: "second", message: "two" },
      ],
    },
    chainStart: async () => {
      next += 1;
      return chainStartForIndex(next, null);
    },
    awaitChain: async (conversationId) => {
      if (conversationId === "conversation-1") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      completionOrder.push(conversationId);
      return conversationId === "conversation-1"
        ? { status: "completed", final_agent: "a", response_text: "done" }
        : { status: "failed", final_agent: "b", response_text: "failed" };
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(completionOrder).toEqual(["conversation-2", "conversation-1"]);
  expect(result.results.map((r) => r.label)).toEqual(["first", "second"]);
  expect(result.results.map((r) => r.index)).toEqual([0, 1]);
});

// ---------------------------------------------------------------------------
// Response modes
// ---------------------------------------------------------------------------

test("response_mode full writes artifact with exact bytes and returns path/chars/check_line", async () => {
  const writtenFiles: { path: string; body: string }[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [{ label: "task-a", message: "work", response_mode: "full" }],
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "line one\nline two\nline three",
    }),
    fileWrite: async (path, body) => {
      writtenFiles.push({ path, body });
      return path;
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.response_mode).toBe("full");
  expect(result.results[0]?.response_path).toBeTruthy();
  expect(result.results[0]?.response_chars).toBe("line one\nline two\nline three".length);
  expect(result.results[0]?.check_line).toBe("line one");
  expect(writtenFiles).toHaveLength(1);
  expect(writtenFiles[0]?.body).toBe("line one\nline two\nline three");
  expect(writtenFiles[0]?.path).toContain("task-a-0");
});

test("response_mode first_line returns first nonempty line and failure_tail on failure", async () => {
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work", response_mode: "first_line" }],
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "failed",
      final_agent: "executor",
      response_text: "first line\nsecond line\n" + "x".repeat(5000),
    }),
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.response_mode).toBe("first_line");
  expect(result.results[0]?.response_path).toBeNull();
  expect(result.results[0]?.check_line).toBe("first line");
  expect(result.results[0]?.failure_tail).toBeTruthy();
  expect(result.results[0]?.failure_tail!.length).toBeLessThanOrEqual(4000);
});

test("response_mode none suppresses response body and artifact", async () => {
  const writtenFiles: string[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work", response_mode: "none" }],
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    fileWrite: async (path) => {
      writtenFiles.push(path);
      return path;
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.response_mode).toBe("none");
  expect(result.results[0]?.response_path).toBeNull();
  expect(result.results[0]?.check_line).toBeNull();
  expect(result.results[0]?.failure_tail).toBeNull();
  expect(writtenFiles).toHaveLength(0);
  expect(result.results[0]?.status).toBe("completed");
  expect(result.results[0]?.handoff_id).toBe("handoff-0");
});

test("per-task response_mode overrides default", async () => {
  const writtenFiles: string[] = [];
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work", response_mode: "full" }],
      defaults: { response_mode: "none" },
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    fileWrite: async (path) => {
      writtenFiles.push(path);
      return path;
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.response_mode).toBe("full");
  expect(result.results[0]?.response_path).toBeTruthy();
  expect(writtenFiles).toHaveLength(1);
});

test("default response_mode is full when neither task nor default specifies it", async () => {
  const writtenFiles: string[] = [];
  const ctx = makeCtx({
    args: { tasks: [{ message: "work" }] },
    chainStart: async () => chainStartForIndex(0, null),
    fileWrite: async (path) => {
      writtenFiles.push(path);
      return path;
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.response_mode).toBe("full");
  expect(writtenFiles).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Artifact write failures
// ---------------------------------------------------------------------------

test("failed response artifact write makes result explicitly fail", async () => {
  const ctx = makeCtx({
    args: {
      tasks: [{ message: "work", response_mode: "full" }],
    },
    chainStart: async () => chainStartForIndex(0, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    fileWrite: async () => {
      throw new Error("disk full");
    },
  });

  const result = (await fn(ctx, emptyRecall())) as FanoutWorkflowResult;

  expect(result.results[0]?.ok).toBe(false);
  expect(result.results[0]?.response_path).toBeNull();
  expect(result.results[0]?.error_summary).toContain("response_artifact_write_failed");
  expect(result.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// Counts and branch filtering
// ---------------------------------------------------------------------------

test("counts all results correctly including partial failures", async () => {
  let call = 0;
  const result = await runFanoutWorkflow({
    args: {
      tasks: [
        { label: "failed", message: "one" },
        { label: "continued", message: "two" },
      ],
    },
    chainStart: async () => {
      call += 1;
      return call === 1
        ? Response.json({ error: { code: "bad_request" } }, 400)
        : chainStartForIndex(1, "feature/branch-1");
    },
  });

  expect(result.total).toBe(2);
  expect(result.completed).toBe(0);
  expect(result.failed).toBe(2);
  expect(result.ok).toBe(false);
  expect(result.branches).toEqual([]);
});

test("branches list includes only accepted nonempty actual branches", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, {
      handoffId: "handoff-0",
      conversationId: "conversation-0",
      branchName: "feature/branch-0",
    });
    seedResponse(db, {
      conversationId: "conversation-0",
      handoffId: "handoff-0",
      response: "done",
    });
    seedHandoff(db, {
      handoffId: "handoff-1",
      conversationId: "conversation-1",
      branchName: "feature/branch-1",
    });
    seedResponse(db, {
      conversationId: "conversation-1",
      handoffId: "handoff-1",
      response: "done",
    });

    const result = await runFanoutWorkflow({
      args: {
        tasks: [
          { label: "task-0", message: "one" },
          { label: "task-1", message: "two" },
        ],
      },
      db: () => db,
      chainStart: async (input) => {
        const idx = Number(input.task_name?.split("-").pop() ?? "0");
        return chainStartForIndex(idx, null);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(2);
    expect(result.branches).toEqual(["feature/branch-0", "feature/branch-1"]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Label collision safety
// ---------------------------------------------------------------------------

test("label collision produces unique artifact names with index suffix", async () => {
  const writtenFiles: string[] = [];
  let next = 0;
  const ctx = makeCtx({
    args: {
      tasks: [
        { label: "same/label", message: "one", response_mode: "full" },
        { label: "same/label", message: "two", response_mode: "full" },
      ],
    },
    chainStart: async () => chainStartForIndex((next += 1) - 1, null),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "executor",
      response_text: "done",
    }),
    fileWrite: async (path) => {
      writtenFiles.push(path);
      return path;
    },
  });

  await fn(ctx, emptyRecall());

  expect(writtenFiles).toHaveLength(2);
  expect(writtenFiles[0]).not.toBe(writtenFiles[1]);
  expect(writtenFiles[0]).toContain("-0");
  expect(writtenFiles[1]).toContain("-1");
});

// ---------------------------------------------------------------------------
// Progress milestones
// ---------------------------------------------------------------------------

test("emits bounded progress milestones", async () => {
  const progress: { message: string; meta?: Record<string, unknown> }[] = [];
  const ctx = makeCtx({
    args: { tasks: [{ message: "work" }] },
    chainStart: async () => chainStartForIndex(0, null),
    progress: (message, meta) => progress.push({ message, meta }),
  });

  await fn(ctx, emptyRecall());

  expect(progress.map((p) => p.message)).toEqual([
    "penumbra-fanout: dispatching",
    "penumbra-fanout: completed",
  ]);
});

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

test("registry loads penumbra-fanout with zero errors", async () => {
  const { buildRegistry } = await import("@penumbra/workflows");
  const repoRoot = join(import.meta.dir, "../../..");
  const reg = await buildRegistry({
    playbooksDir: join(repoRoot, "plugin/playbooks"),
    workflowsDir: join(repoRoot, "plugin/workflows"),
  });
  expect(reg.errors).toEqual([]);
  expect(reg.get("penumbra-fanout")?.name).toBe("penumbra-fanout");
});
