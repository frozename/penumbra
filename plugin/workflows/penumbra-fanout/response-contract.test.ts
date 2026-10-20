import type { ChainStartRequest } from "@penumbra/core";
import type { WorkflowCtx } from "@penumbra/workflows";

import { DispatchEventLog, HandoffWriter, loadSqliteVec, migrate, T0Writer } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

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

function makeCtx(overrides: Partial<TestCtx> & { args?: Record<string, unknown> }): TestCtx {
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

function acceptedDb(branchName = "feature/accepted"): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const handoffs = new HandoffWriter({ db });
  handoffs.createApproved({
    handoff_id: "handoff-0",
    ts: "2026-09-12T10:00:00.000Z",
    project_id: "penumbra",
    conversation_id: "conversation-0",
    from: "workflow",
    to: "worker",
    to_role: "executor",
    message: "root task",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "review_adversarial",
    use_worktree: true,
    dispatch_kind: "workflow",
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: branchName,
  });
  handoffs.claimDispatch("handoff-0", "worker-1");
  handoffs.markCompleted("handoff-0", {
    ts: "2026-09-12T10:00:10.000Z",
    expected_worker_id: "worker-1",
  });

  new T0Writer(db).write({
    event_id: "response-handoff-0",
    ts: "2026-09-12T10:00:08.000Z",
    ingest_ts: "2026-09-12T10:00:08.000Z",
    source: "agentchat",
    source_detail: "worker",
    project_id: "penumbra",
    user_id: "test",
    machine_id: "test",
    session_id: "conversation-0",
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
      response: "worker response",
      handoff_id: "handoff-0",
      agent: "executor",
    },
    payload_summary: "agent-response",
    origin: "dispatch",
  });

  new DispatchEventLog(db).recordBatch([
    {
      handoff_id: "handoff-0",
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-09-12T10:00:01.000Z",
    },
    {
      handoff_id: "handoff-0",
      source: "worker",
      kind: "proc.spawn",
      ts: "2026-09-12T10:00:02.000Z",
    },
    {
      handoff_id: "handoff-0",
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-09-12T10:00:09.000Z",
      meta: { committed: true, worktree_changed: true },
    },
  ]);
  return db;
}

function chainStart(): Response {
  return Response.json({
    conversation_id: "conversation-0",
    handoff_id: "handoff-0",
    branch_name: null,
  });
}

test("serialized summaries omit the worker body in every response mode", async () => {
  const hiddenMarker = "HIDDEN_BODY_MARKER_7b62a";
  const body = `${"v".repeat(450)}\n${hiddenMarker}\n${"x".repeat(5_000)}`;

  for (const mode of ["full", "first_line", "none"] as const) {
    const db = acceptedDb();
    const writes: { path: string; body: string }[] = [];
    try {
      const result = (await fn(
        makeCtx({
          args: { tasks: [{ label: `task-${mode}`, message: "work", response_mode: mode }] },
          db: () => db,
          chainStart: async () => chainStart(),
          awaitChain: async () => ({
            status: "completed",
            final_agent: "executor",
            response_text: body,
          }),
          fileWrite: async (path, artifactBody) => {
            writes.push({ path, body: artifactBody });
            return path;
          },
        }),
        emptyRecall(),
      )) as FanoutWorkflowResult;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("response_text");
      expect(serialized).not.toContain(hiddenMarker);
      expect(result.results[0]?.check_line?.length ?? 0).toBeLessThanOrEqual(300);

      if (mode === "full") {
        expect(writes).toHaveLength(1);
        expect(writes[0]?.body).toBe(body);
        expect(result.results[0]?.response_path).toBe(writes[0]?.path ?? null);
      } else {
        expect(writes).toHaveLength(0);
        expect(result.results[0]?.response_path).toBeNull();
      }

      if (mode === "none") {
        expect(result.results[0]?.check_line).toBeNull();
        expect(result.results[0]?.failure_tail).toBeNull();
      }
    } finally {
      db.close();
    }
  }
});

test("completed trustworthy CHECK_RESULT FAIL keeps semantic success and returns a bounded tail", async () => {
  const db = acceptedDb("feature/check-fail");
  const tailMarker = "TAIL_MARKER_1f92c";
  const body = `\n  check_result:   fail  \nreview details\n${"x".repeat(5_000)}${tailMarker}`;
  try {
    const result = (await fn(
      makeCtx({
        args: { tasks: [{ message: "review", response_mode: "first_line" }] },
        db: () => db,
        chainStart: async () => chainStart(),
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: body,
        }),
      }),
      emptyRecall(),
    )) as FanoutWorkflowResult;

    expect(result.ok).toBe(true);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[0]?.check_line).toBe("check_result:   fail");
    expect(result.results[0]?.failure_tail?.length).toBeLessThanOrEqual(4_000);
    expect(result.results[0]?.failure_tail).toContain(tailMarker);
    expect(result.branches).toEqual(["feature/check-fail"]);
  } finally {
    db.close();
  }
});

test("invalid fileWrite receipts fail closed and exclude the candidate branch", async () => {
  for (const receipt of ["", "   ", "not-the-requested-path", null] as const) {
    const db = acceptedDb("feature/write-receipt");
    try {
      const result = (await fn(
        makeCtx({
          args: { tasks: [{ message: "work", response_mode: "full" }] },
          db: () => db,
          chainStart: async () => chainStart(),
          awaitChain: async () => ({
            status: "completed",
            final_agent: "executor",
            response_text: "done",
          }),
          fileWrite: async () => receipt as string,
        }),
        emptyRecall(),
      )) as FanoutWorkflowResult;

      expect(result.ok).toBe(false);
      expect(result.results[0]?.ok).toBe(false);
      expect(result.results[0]?.response_path).toBeNull();
      expect(result.results[0]?.response_chars).toBeNull();
      expect(result.results[0]?.error_summary).toContain("response_artifact_write_failed");
      expect(result.branches).toEqual([]);
    } finally {
      db.close();
    }
  }
});

test("rejects more than sixteen tasks before chainStart", async () => {
  let chainStartCalls = 0;
  let caught: unknown;
  try {
    await fn(
      makeCtx({
        args: {
          tasks: Array.from({ length: 17 }, (_, index) => ({ message: `task-${String(index)}` })),
        },
        chainStart: async () => {
          chainStartCalls += 1;
          return chainStart();
        },
      }),
      emptyRecall(),
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(chainStartCalls).toBe(0);
  expect(
    inputSchema.safeParse({
      tasks: Array.from({ length: 16 }, (_, index) => ({ message: `task-${String(index)}` })),
    }).success,
  ).toBe(true);
});

test("rejects labels over 120 characters before chainStart without truncation", async () => {
  let chainStartCalls = 0;
  let caught: unknown;
  try {
    await fn(
      makeCtx({
        args: { tasks: [{ message: "work", label: "l".repeat(121) }] },
        chainStart: async () => {
          chainStartCalls += 1;
          return chainStart();
        },
      }),
      emptyRecall(),
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(chainStartCalls).toBe(0);
  expect(
    inputSchema.safeParse({ tasks: [{ message: "work", label: "l".repeat(120) }] }).success,
  ).toBe(true);
});
