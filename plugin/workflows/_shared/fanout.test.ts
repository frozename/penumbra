import { type ChainStartRequest, HandoffWriter, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { type FanoutCtx, type FanoutTaskResult, runFanout } from "./fanout.js";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function context(overrides: Partial<FanoutCtx> = {}): FanoutCtx {
  return {
    dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
    awaitChain: async () => ({
      status: "completed",
      final_agent: "worker",
      response_text: "done",
    }),
    cancel: async () => {},
    fileWrite: async (path) => path,
    config: {},
    cwd: "/repo",
    storageRoot: "/storage",
    project: "project-one",
    args: {},
    chainStart: async () =>
      response({ conversation_id: "conversation-1", handoff_id: "handoff-1" }),
    ...overrides,
  };
}

function migratedHandoffDb(input: {
  handoffId: string;
  conversationId: string;
  branchName: string;
}): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  new HandoffWriter({ db }).createApproved({
    handoff_id: input.handoffId,
    ts: "2026-09-12T10:00:00.000Z",
    project_id: "project-one",
    conversation_id: input.conversationId,
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
    use_worktree: false,
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: input.branchName,
  });
  return db;
}

describe("runFanout dispatch contract", () => {
  test("passes every supported chain field and preserves explicit false values", async () => {
    const captured: ChainStartRequest[] = [];
    const ctx = context({
      chainStart: async (input) => {
        captured.push(input);
        return response({ conversation_id: "conversation-1", handoff_id: "handoff-1" });
      },
    });

    await runFanout(ctx, {
      defaults: {
        initial_agent: "executor",
        task_class: "STANDARD",
        task_type: "implement_small",
        trust_mode: "all",
        use_worktree: true,
        isolated_install: true,
        tool_free: true,
        max_hops: 8,
        timeout_ms: 9_000,
        project_id: "default-project",
      },
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
    });

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
    const ctx = context({
      config: { default_roles: { executor: "global-seat" } },
      chainStart: async (input) => {
        captured.push(input);
        return response({ conversation_id: "conversation-1", handoff_id: "handoff-1" });
      },
    });

    await runFanout(ctx, { defaults: {}, tasks: [{ message: "work" }] });

    expect(captured[0]?.initial_agent).toBe("executor");
    expect(captured[0]?.project_id).toBe("project-one");
  });

  test("uses a task label as task_name only when task_name is absent", async () => {
    const captured: ChainStartRequest[] = [];
    const ctx = context({
      chainStart: async (input) => {
        captured.push(input);
        return response({
          conversation_id: `conversation-${String(captured.length)}`,
          handoff_id: `handoff-${String(captured.length)}`,
        });
      },
    });

    await runFanout(ctx, {
      defaults: { task_name: "default name" },
      tasks: [
        { label: "label name", message: "one" },
        { label: "ignored label", task_name: "explicit name", message: "two" },
      ],
    });

    expect(captured.map((item) => item.task_name)).toEqual(["label name", "explicit name"]);
  });

  test("fails truthfully without raw chainStart or project scope", async () => {
    let calls = 0;
    const missingCapability = context({ chainStart: undefined });
    const missingScope = context({
      project: "",
      chainStart: async () => {
        calls += 1;
        return response({ conversation_id: "c", handoff_id: "h" });
      },
    });

    const noCapability = await runFanout(missingCapability, {
      defaults: {},
      tasks: [{ message: "work" }],
    });
    const noScope = await runFanout(missingScope, {
      defaults: {},
      tasks: [{ message: "work" }],
    });

    expect(noCapability.results[0]?.error_summary).toBe("chain_start_unavailable");
    expect(noScope.results[0]?.error_summary).toBe("project_scope_required");
    expect(calls).toBe(0);
  });
});

describe("runFanout deadline and retry contract", () => {
  test("passes the exact smaller remaining run budget to awaitChain", async () => {
    const timeoutCalls: number[] = [];
    let deadlineCall = 0;
    const remaining = [10_000, 3_217];
    const ctx = context({
      deadline: () => {
        const remaining_ms = remaining[deadlineCall++] ?? 3_217;
        return { remaining_ms, expired: remaining_ms <= 0 };
      },
      awaitChain: async (_conversationId, opts) => {
        timeoutCalls.push(opts?.timeoutMs ?? -1);
        return { status: "completed", final_agent: "worker", response_text: "done" };
      },
    });

    await runFanout(ctx, {
      defaults: { timeout_ms: 8_000 },
      tasks: [{ message: "work" }],
    });

    expect(timeoutCalls).toEqual([3_217]);
  });

  test("zero remaining budget prevents initial dispatch and post-dispatch wait", async () => {
    let starts = 0;
    let waits = 0;
    const expired = context({
      deadline: () => ({ remaining_ms: 0, expired: true }),
      chainStart: async () => {
        starts += 1;
        return response({ conversation_id: "c", handoff_id: "h" });
      },
    });
    const expiresAfterStart = context({
      deadline: (() => {
        let call = 0;
        return () =>
          ++call === 1 ? { remaining_ms: 5, expired: false } : { remaining_ms: 0, expired: true };
      })(),
      awaitChain: async () => {
        waits += 1;
        return { status: "completed", final_agent: "worker", response_text: "done" };
      },
    });

    const before = await runFanout(expired, { defaults: {}, tasks: [{ message: "a" }] });
    const after = await runFanout(expiresAfterStart, {
      defaults: {},
      tasks: [{ message: "b" }],
    });

    expect(starts).toBe(0);
    expect(waits).toBe(0);
    expect(before.results[0]?.error_summary).toBe("run_deadline_expired");
    expect(after.results[0]).toMatchObject({
      handoff_id: "handoff-1",
      root_handoff_id: "handoff-1",
      error_summary: "run_deadline_expired",
    });
  });

  test("retries only nested supported HTTP 503 error codes", async () => {
    const attempted: string[] = [];
    const supported = context({
      chainStart: async () => {
        attempted.push("supported");
        return attempted.length === 1
          ? response({ error: { code: "no_worker_registered", message: "none" } }, 503)
          : response({ conversation_id: "c", handoff_id: "h" });
      },
    });
    let topLevelCalls = 0;
    const topLevel = context({
      chainStart: async () => {
        topLevelCalls += 1;
        return response({ code: "worker_heartbeats_stale" }, 503);
      },
    });
    let thrownCalls = 0;
    const thrown = context({
      chainStart: async () => {
        thrownCalls += 1;
        throw new Error("503 no_worker_registered");
      },
    });

    const retried = await runFanout(supported, {
      defaults: {},
      tasks: [{ message: "work" }],
      retryBackoffMs: 0,
    });
    const notNested = await runFanout(topLevel, {
      defaults: {},
      tasks: [{ message: "work" }],
      retryBackoffMs: 0,
    });
    const notResponse = await runFanout(thrown, {
      defaults: {},
      tasks: [{ message: "work" }],
      retryBackoffMs: 0,
    });

    expect(attempted).toHaveLength(2);
    expect(retried.results[0]?.retry_count).toBe(1);
    expect(topLevelCalls).toBe(1);
    expect(notNested.results[0]?.retry_count).toBe(0);
    expect(thrownCalls).toBe(1);
    expect(notResponse.results[0]?.retry_count).toBe(0);
  });

  test("does not start a supported retry when backoff exhausts the run deadline", async () => {
    let starts = 0;
    let deadlineCall = 0;
    const remaining = [10, 4];
    const ctx = context({
      deadline: () => {
        const remaining_ms = remaining[deadlineCall++] ?? 4;
        return { remaining_ms, expired: remaining_ms <= 0 };
      },
      chainStart: async () => {
        starts += 1;
        return response({ error: { code: "worker_heartbeats_stale" } }, 503);
      },
    });

    const out = await runFanout(ctx, {
      defaults: {},
      tasks: [{ message: "work" }],
      retryBackoffMs: 5,
    });

    expect(starts).toBe(1);
    expect(out.results[0]).toMatchObject({ retry_count: 0, error_summary: "run_deadline_expired" });
  });
});

describe("runFanout result isolation", () => {
  test("preserves input order when sibling waits complete out of order", async () => {
    const completionOrder: string[] = [];
    let next = 0;
    const ctx = context({
      chainStart: async () => {
        next += 1;
        return response({ conversation_id: `c-${next}`, handoff_id: `h-${next}` });
      },
      awaitChain: async (conversationId) => {
        if (conversationId === "c-1") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
        }
        completionOrder.push(conversationId);
        return conversationId === "c-1"
          ? { status: "completed", final_agent: "a", response_text: "done" }
          : { status: "failed", final_agent: "b", response_text: "failed" };
      },
    });

    const out = await runFanout(ctx, {
      defaults: {},
      tasks: [
        { label: "first", message: "one" },
        { label: "second", message: "two" },
      ],
    });

    expect(completionOrder).toEqual(["c-2", "c-1"]);
    expect(out.results.map((item) => item.label)).toEqual(["first", "second"]);
    expect(out.results.map((item) => item.handoff_id)).toEqual(["h-1", "h-2"]);
  });

  test("keeps identifiers when wait throws or the response is missing", async () => {
    const thrown = await runFanout(
      context({
        chainStart: async () =>
          response({
            conversation_id: "throw-c",
            handoff_id: "throw-h",
            branch_name: "actual-start",
          }),
        awaitChain: async () => {
          throw new Error("wait broke");
        },
      }),
      { defaults: {}, tasks: [{ message: "throw" }] },
    );
    const missing = await runFanout(
      context({
        chainStart: async () => response({ conversation_id: "missing-c", handoff_id: "missing-h" }),
        awaitChain: async () => ({ status: "completed", final_agent: "a", response_text: null }),
      }),
      { defaults: {}, tasks: [{ message: "missing" }] },
    );

    expect(thrown.results[0]).toMatchObject({
      conversation_id: "throw-c",
      handoff_id: "throw-h",
      root_handoff_id: "throw-h",
      branch_name: "actual-start",
      error_summary: "wait_failed",
    });
    expect(missing.results[0]).toMatchObject({
      conversation_id: "missing-c",
      handoff_id: "missing-h",
      error_summary: "missing_response",
    });
  });

  test("reads the actual root branch after a wait failure and never parses response prose", async () => {
    const db = migratedHandoffDb({
      handoffId: "root-real",
      conversationId: "conversation-real",
      branchName: "actual-db-branch",
    });
    try {
      const out = await runFanout(
        context({
          db: () => db,
          chainStart: async () =>
            response({
              conversation_id: "conversation-real",
              handoff_id: "root-real",
              branch_name: "stale-provisional",
            }),
          awaitChain: async () => {
            throw new Error("wait failed after dispatch");
          },
        }),
        {
          defaults: {},
          tasks: [{ message: "agent prose mentions invented-branch" }],
        },
      );

      expect(out.results[0]).toMatchObject({
        handoff_id: "root-real",
        root_handoff_id: "root-real",
        latest_handoff_id: "root-real",
        branch_name: "actual-db-branch",
        branch_base: "main",
        error_summary: "wait_failed",
      });
    } finally {
      db.close();
    }
  });

  test("keeps each failure and does not report an empty fanout as successful", async () => {
    let call = 0;
    const mixed = await runFanout(
      context({
        chainStart: async () => {
          call += 1;
          return call === 1
            ? response({ error: { code: "bad_request" } }, 400)
            : response({ conversation_id: "ok-c", handoff_id: "ok-h" });
        },
      }),
      {
        defaults: {},
        tasks: [
          { label: "failed", message: "one" },
          { label: "continued", message: "two" },
        ],
      },
    );
    const empty = await runFanout(context(), { defaults: {}, tasks: [] });

    expect(mixed.results).toHaveLength(2);
    expect(mixed.results[0]?.error_summary).toBe("chain_start_failed");
    expect(mixed.results[1]?.handoff_id).toBe("ok-h");
    expect(mixed.ok).toBe(false);
    expect(empty).toEqual({ ok: false, results: [] });
  });

  test("fails closed when DB access is absent or throws without claiming zero hops", async () => {
    const absent = await runFanout(context(), { defaults: {}, tasks: [{ message: "one" }] });
    const broken = await runFanout(
      context({
        db: () => {
          throw new Error("db unavailable");
        },
      }),
      { defaults: {}, tasks: [{ message: "two" }] },
    );

    for (const result of [absent.results[0], broken.results[0]]) {
      expect(result).toMatchObject({
        ok: false,
        reliability_trustworthy: null,
        latest_reliability_status: null,
        latest_reliability_trustworthy: null,
        latest_reliability_action: null,
        hop_count: null,
        extra_hops: null,
        retry_prompt_count: null,
      } satisfies Partial<FanoutTaskResult>);
      expect(result?.error_summary).toBe("reliability_unverified");
    }
  });
});
