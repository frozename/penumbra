import type { ChainStartRequest } from "@penumbra/core";

import { describe, expect, test } from "bun:test";

import { type FanoutCtx, runFanout } from "./fanout.js";

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

describe("runFanout CC default parity", () => {
  test("defaults to 120 minutes and preserves task/default timeout overrides", async () => {
    const timeouts: (number | undefined)[] = [];
    const ctx = context({
      awaitChain: async (_id, opts) => {
        timeouts.push(opts?.timeoutMs);
        return { status: "completed", final_agent: "worker", response_text: "done" };
      },
    });
    await runFanout(ctx, { defaults: {}, tasks: [{ message: "work" }] });
    await runFanout(ctx, { defaults: { timeout_ms: 1234 }, tasks: [{ message: "work" }] });
    await runFanout(ctx, {
      defaults: { timeout_ms: 1234 },
      tasks: [{ message: "work", timeout_ms: 5678 }],
    });
    expect(timeouts).toEqual([7_200_000, 1234, 5678]);
  });

  test("fills omitted task defaults to match the CC fanout script", async () => {
    const captured: ChainStartRequest[] = [];
    const ctx = context({
      chainStart: async (input) => {
        captured.push(input);
        return response({
          conversation_id: "conversation-1",
          handoff_id: "handoff-1",
        });
      },
    });

    await runFanout(ctx, { defaults: {}, tasks: [{ message: "work" }] });

    expect(captured[0]).toEqual({
      initial_agent: "executor",
      message: "work",
      project_id: "project-one",
      task_class: "STANDARD",
      task_type: "unknown",
      trust_mode: "all",
      use_worktree: true,
      max_hops: 8,
      dispatch_kind: "workflow",
      caller_cwd: "/repo",
    });
  });

  test("per-task and defaults values override the floor defaults", async () => {
    const captured: ChainStartRequest[] = [];
    const ctx = context({
      chainStart: async (input) => {
        captured.push(input);
        return response({
          conversation_id: "conversation-1",
          handoff_id: "handoff-1",
        });
      },
    });

    await runFanout(ctx, {
      defaults: {
        initial_agent: "reviewer",
        task_class: "BOUNDARY",
        task_type: "review_adversarial",
        trust_mode: "all",
        use_worktree: true,
        max_hops: 8,
      },
      tasks: [
        {
          message: "work",
          initial_agent: "planner",
          task_class: "TRIVIAL",
          task_type: "docs_mechanical",
          trust_mode: "config",
          use_worktree: false,
          max_hops: 1,
        },
      ],
    });

    expect(captured[0]).toMatchObject({
      initial_agent: "planner",
      task_class: "TRIVIAL",
      task_type: "docs_mechanical",
      trust_mode: "config",
      use_worktree: false,
      max_hops: 1,
    });
  });

  test("explicit use_worktree false in defaults is preserved", async () => {
    const captured: ChainStartRequest[] = [];
    const ctx = context({
      chainStart: async (input) => {
        captured.push(input);
        return response({
          conversation_id: "conversation-1",
          handoff_id: "handoff-1",
        });
      },
    });

    await runFanout(ctx, {
      defaults: { use_worktree: false },
      tasks: [{ message: "work" }],
    });

    expect(captured[0]?.use_worktree).toBe(false);
  });
});
