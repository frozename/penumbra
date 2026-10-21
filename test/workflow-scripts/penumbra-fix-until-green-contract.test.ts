import { describe, expect, test } from "bun:test";

import { readRuntimeBody, runWorkflowCapturingPrompts } from "./harness.js";

const FIX_UNTIL_GREEN = ".claude/workflows/penumbra-fix-until-green.js";

interface FanoutArgs {
  tasks: Array<Record<string, unknown>>;
  defaults?: Record<string, unknown>;
  dispatcherModel?: string;
  agentType?: string;
  repo?: string;
}

interface Round {
  reason?: string;
  rubric_status?: string;
  rubric_grade?: unknown;
  passed?: boolean;
  verified?: boolean;
  check_exit?: number;
  check_verify_status?: string;
  check_passed?: boolean;
  ci_parity?: boolean;
  hint?: string;
}

interface FixUntilGreenResult {
  result: Record<string, unknown> | undefined;
  workflowCalls: Array<{ name: string; args: unknown }>;
  agentCalls: Array<{ prompt: string; options?: Record<string, unknown> }>;
  logs: string[];
  error?: unknown;
}

async function runFixUntilGreen(
  args: unknown,
  stubs: {
    workflow?: (name: string, wArgs: unknown) => Promise<unknown>;
    agent?: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
  } = {},
): Promise<FixUntilGreenResult> {
  const body = readRuntimeBody(FIX_UNTIL_GREEN);
  const workflowCalls: Array<{ name: string; args: unknown }> = [];
  const agentCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    agentCalls.push({ prompt: String(prompt), options });
    return stubs.agent ? await stubs.agent(prompt, options) : {};
  };

  const parallel = async (items: unknown[]) =>
    Promise.all(
      items.map((item) => (typeof item === "function" ? (item as () => unknown)() : item)),
    );

  const pipeline = async (items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>) =>
    stages.reduce<Promise<unknown[]>>(
      async (acc, stage) => Promise.all((await acc).map((item, i) => stage(item, items[i]))),
      Promise.resolve(items),
    );

  const phase = async (_name: string, fn?: () => unknown) => (fn ? fn() : undefined);
  const logs: string[] = [];
  const log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  const workflow = async (name: string, wArgs: unknown) => {
    workflowCalls.push({ name, args: wArgs });
    return stubs.workflow ? await stubs.workflow(name, wArgs) : {};
  };

  const run = new Function(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    `"use strict"; return (async () => {\n${body}\n})()`,
  ) as (
    a: unknown,
    p: unknown,
    pl: unknown,
    ph: unknown,
    l: unknown,
    ar: unknown,
    b: unknown,
    w: unknown,
  ) => Promise<unknown>;

  try {
    const result = (await run(agent, parallel, pipeline, phase, log, args, {}, workflow)) as
      | Record<string, unknown>
      | undefined;
    return { result, workflowCalls, agentCalls, logs };
  } catch (error) {
    return { result: undefined, workflowCalls, agentCalls, logs, error };
  }
}

describe("penumbra-fix-until-green argument forwarding", () => {
  for (const agentType of [undefined, "inherit", "penumbra:penumbra-fanout-proxy"]) {
    test(`forwards agentType ${String(agentType)} only when supplied`, async () => {
      const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
        task: { message: "work" },
        check: "true",
        repo: "/repo",
        ...(agentType !== undefined ? { agentType } : {}),
      });
      expect(error).toBeUndefined();
      const forwarded = workflowCalls.find((call) => call.name === "penumbra-fanout")
        ?.args as FanoutArgs;
      expect(forwarded).toBeDefined();
      if (agentType === undefined) expect(forwarded).not.toHaveProperty("agentType");
      else expect(forwarded.agentType).toBe(agentType);
    });
  }

  for (const [record, reason] of [
    [{ ok: true, reliability_trustworthy: true, branch: "feat/x" }, "no_dispatch"],
    [
      { ok: false, conversation_id: "c", handoff_id: "h", error_summary: "worker failed" },
      "chain_failed",
    ],
    [{ ok: false, status: "proxy_error", error_summary: "proxy_error: denied" }, "no_dispatch"],
  ] as const) {
    test(`dispatch classification gives ${reason} precedence`, async () => {
      const { result, error } = await runFixUntilGreen(
        { task: { message: "work" }, check: "true", repo: "/repo" },
        {
          workflow: async () => ({ results: [record] }),
        },
      );
      expect(error).toBeUndefined();
      expect((result?.rounds as Round[])?.[0]?.reason).toBe(reason);
    });
  }

  test("task.response_mode='full' reaches the dispatched task", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
      task: { message: "m", response_mode: "full" },
      check: "true",
      defaults: { caller_cwd: "/abs" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const args = fanout!.args as FanoutArgs;
    expect(args.tasks[0]?.response_mode).toBe("full");
  });

  test("defaults.response_mode='full' reaches when task omits it", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
      task: { message: "m" },
      check: "true",
      defaults: { response_mode: "full", caller_cwd: "/abs" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const args = fanout!.args as FanoutArgs;
    expect(args.tasks[0]?.response_mode).toBe("full");
  });

  test("defaults.task_name reaches when no per-task name is set", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
      task: { message: "m" },
      check: "true",
      defaults: { task_name: "MY-DEFAULT-NAME", caller_cwd: "/abs" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const args = fanout!.args as FanoutArgs;
    expect(args.tasks[0]?.task_name).toBe("MY-DEFAULT-NAME");
  });

  test("per-task task_name overrides defaults.task_name", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
      task: { message: "m", task_name: "TASK-1" },
      check: "true",
      defaults: { task_name: "DEFAULT", caller_cwd: "/abs" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const args = fanout!.args as FanoutArgs;
    expect(args.tasks[0]?.task_name).toBe("TASK-1");
  });

  test("maxRounds:0 dispatches nothing", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(FIX_UNTIL_GREEN, {
      task: { message: "m" },
      check: "true",
      maxRounds: 0,
      defaults: { caller_cwd: "/abs" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeUndefined();
    expect(workflowCalls).toHaveLength(0);
  });
});

describe("penumbra-fix-until-green dispatch failure reasons", () => {
  test("agent_dropped when fanout returns no result", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      { workflow: async () => ({}) },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("agent_dropped");
  });

  test("chain_failed when dispatch ok is false", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              conversation_id: "c",
              handoff_id: "h",
              ok: false,
              reliability_trustworthy: true,
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("chain_failed");
  });

  test("completed_no_branch when dispatch ok is true but branch is missing", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              conversation_id: "c",
              handoff_id: "h",
              ok: true,
              reliability_trustworthy: true,
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("completed_no_branch");
  });

  test("the stop log surfaces the dispatch error_summary when present", async () => {
    const { result, logs } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: false,
              status: "no_dispatch",
              error_summary: "no_dispatch: prompt_project_mismatch",
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("no_dispatch");
    expect(logs.some((log) => log.includes("prompt_project_mismatch"))).toBe(true);
  });

  test("untrustworthy_dispatch when reliability_trustworthy is false", async () => {
    // The real fanout forces ok:false once its trust gate closes — feed the
    // shape it actually emits, not an ok:true mock that can never reach us.
    const { result, logs } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              conversation_id: "c",
              handoff_id: "h",
              ok: false,
              status: "completed",
              branch: "feat/x",
              reliability_status: "complete",
              reliability_trustworthy: false,
              reliability_action: "inspect_worktree",
              error_summary: "reliability_untrustworthy",
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("untrustworthy_dispatch");
    expect(logs.some((log) => log.includes("audited and distrusted"))).toBe(true);
  });

  test("untrustworthy_dispatch when reliability_trustworthy is missing", async () => {
    const { result, logs } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              conversation_id: "c",
              handoff_id: "h",
              ok: false,
              status: "completed",
              branch: "feat/x",
              error_summary: "reliability_unverified",
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("untrustworthy_dispatch");
    expect(logs.some((log) => log.includes("never audited"))).toBe(true);
  });

  test("a handoff-id-only dispatch is not mislabeled no_dispatch", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              status: "completed",
              branch: "feat/x",
              handoff_id: "h",
              reliability_trustworthy: true,
              check_line: "CHECK_RESULT: PASS",
            },
          ],
        }),
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBeUndefined();
    expect(result?.green).toBe(true);
  });

  test("chain_failed logs the chain status and error_summary", async () => {
    const { result, logs } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: false,
              status: "failed",
              conversation_id: "c",
              handoff_id: "h",
              error_summary: "worker exploded",
              label: "t0",
              index: 0,
            },
          ],
        }),
      },
    );

    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("chain_failed");
    const stopLog = logs.find((log) => log.includes("stopping")) ?? "";
    expect(stopLog).toContain("status=failed");
    expect(stopLog).toContain("worker exploded");
  });
});

describe("penumbra-fix-until-green grader availability", () => {
  test("null grader is reported as GRADER_UNAVAILABLE", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              branch: "feat/x",
              handoff_id: "h-123",
              conversation_id: "c",
              reliability_trustworthy: true,
              check_line: "CHECK_RESULT: PASS",
            },
          ],
        }),
        agent: async (_prompt, options) => {
          if (String(options?.label ?? "").startsWith("verify-check"))
            return { ran: true, check_exit: 0 };
          if (String(options?.label ?? "").startsWith("rubric")) return null;
          return {};
        },
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    expect(rounds?.[0]?.rubric_grade).toBeNull();
    expect(rounds?.[0]?.passed).toBe(false);
    expect(agentCalls.some((call) => String(call.options?.label ?? "").startsWith("rubric"))).toBe(
      true,
    );
  });

  test("a throwing rubric grader yields GRADER_UNAVAILABLE instead of rejecting", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              branch: "feat/x",
              conversation_id: "c",
              reliability_trustworthy: true,
              check_line: "CHECK_RESULT: PASS",
              handoff_id: "h-123",
            },
          ],
        }),
        agent: async (_prompt, options) => {
          if (String(options?.label ?? "").startsWith("verify-check"))
            return { ran: true, check_exit: 0 };
          if (String(options?.label ?? "").startsWith("rubric")) throw new Error("grader exploded");
          return {};
        },
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    expect(rounds?.[0]?.rubric_grade).toBeNull();
    expect(rounds?.[0]?.passed).toBe(false);
  });
});

describe("penumbra-fix-until-green full response parsing", () => {
  test("response_mode='full' parses CHECK_RESULT from later in the response", async () => {
    const { result, workflowCalls } = await runFixUntilGreen(
      {
        task: { message: "m", response_mode: "full" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              branch: "feat/x",
              handoff_id: "h-123",
              conversation_id: "c",
              reliability_trustworthy: true,
              response: "Here is some narrative\n\nCHECK_RESULT: PASS\n",
            },
          ],
        }),
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const fanout = workflowCalls[0];
    expect(fanout).toBeDefined();
    const args = fanout.args as FanoutArgs;
    expect(args.tasks[0]?.response_mode).toBe("full");
  });
});

describe("penumbra-fix-until-green independent check verification", () => {
  const trustworthyPassFanout = async () => ({
    results: [
      {
        ok: true,
        branch: "feat/x",
        conversation_id: "c",
        reliability_trustworthy: true,
        check_line: "CHECK_RESULT: PASS",
        handoff_id: "h-123",
      },
    ],
  });

  test("a worker PASS with a verifier check_exit 1 is not green", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({
          ran: true,
          check_exit: 1,
          failing_segment: "bun run lint:strict",
          output_tail: "2 problems",
        }),
      },
    );

    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.verified).toBe(false);
    expect(rounds?.[0]?.check_exit).toBe(1);
  });

  test("a worker PASS with a verifier check_exit 0 is green", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.verified).toBe(true);
  });

  test("a null verifier fails closed and does not report green", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => null,
      },
    );

    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.check_verify_status).toBe("unavailable");
  });

  test("verifyCheck:false skips the verifier and preserves the old behaviour", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        verifyCheck: false,
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => {
          throw new Error("agent should not be called");
        },
      },
    );

    expect(result?.green).toBe(true);
    expect(agentCalls).toHaveLength(0);
  });

  test("a verifier that reports ran:false is treated as a failure", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: false, check_exit: -1 }),
      },
    );

    expect(result?.green).toBe(false);
  });

  test("check_line holding narration recovers the verdict from the full response", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              branch: "feat/x",
              conversation_id: "c",
              reliability_trustworthy: true,
              check_line: "Let me inspect the file.",
              response: "Working...\nCHECK_RESULT: PASS\ndone",
              handoff_id: "h-123",
            },
          ],
        }),
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(result?.green).toBe(true);
  });

  test("an explicit CHECK_RESULT: FAIL in check_line stays a failure", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: async () => ({
          results: [
            {
              ok: true,
              branch: "feat/x",
              conversation_id: "c",
              reliability_trustworthy: true,
              check_line: "CHECK_RESULT: FAIL",
              response: "CHECK_RESULT: PASS",
              handoff_id: "h-123",
            },
          ],
        }),
        agent: async () => {
          throw new Error("agent should not be called");
        },
      },
    );

    expect(result?.green).toBe(false);
    expect(agentCalls).toHaveLength(0);
  });

  test("a caller with caller_cwd but no repo still reaches green", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        caller_cwd: "/abs/repo",
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.verified).toBe(true);
    expect(rounds?.[0]?.check_verify_status).toBe("passed");
  });

  test("a throwing verifier yields VERIFIER_UNAVAILABLE rather than rejecting", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => {
          throw new Error("verifier crashed");
        },
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.check_verify_status).toBe("unavailable");
    expect(rounds?.[0]?.verified).toBe(false);
  });

  test("the verifier prompt offers the git worktree list fallback even when the repo root is absolute", async () => {
    const { agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("/abs-worktrees/h-123");
    expect(verifyCall!.prompt).toContain("git worktree list");
    expect(verifyCall!.prompt).toContain("feat/x");
    expect(verifyCall!.prompt).toContain("h-123");
  });

  test("the verifier prompt requests failing_segment and output_tail", async () => {
    const { agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("failing_segment");
    expect(verifyCall!.prompt).toContain("output_tail");
  });

  test("an undefined verifier result fails closed and never yields green", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => undefined,
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.check_verify_status).toBe("unavailable");
    expect(rounds?.[0]?.verified).toBe(false);
  });

  test("two consecutive rounds with ran:false break the loop", async () => {
    const { result, workflowCalls, logs } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 4,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: false, check_exit: -1 }),
      },
    );

    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const fanoutCalls = workflowCalls.filter((call) => call.name === "penumbra-fanout");
    expect(fanoutCalls).toHaveLength(2);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds).toHaveLength(2);
    expect(logs.some((entry) => /verifier/i.test(entry) && /consecutive/i.test(entry))).toBe(true);
  });

  test("a round where the verifier ran resets the consecutive ran:false counter", async () => {
    const verifierResults = [
      { ran: false, check_exit: -1 },
      {
        ran: true,
        check_exit: 1,
        failing_segment: "bun run lint:strict",
        output_tail: "boom",
      },
      { ran: false, check_exit: -1 },
      { ran: true, check_exit: 0 },
    ];
    let verifyCallIndex = 0;
    const { result, workflowCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run lint:strict",
        maxRounds: 4,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => verifierResults[Math.min(verifyCallIndex++, verifierResults.length - 1)],
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const fanoutCalls = workflowCalls.filter((call) => call.name === "penumbra-fanout");
    expect(fanoutCalls).toHaveLength(4);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds).toHaveLength(4);
  });
});

describe("penumbra-fix-until-green CI parity verification", () => {
  const trustworthyPassFanout = async () => ({
    results: [
      {
        ok: true,
        branch: "feat/x",
        conversation_id: "c",
        reliability_trustworthy: true,
        check_line: "CHECK_RESULT: PASS",
        handoff_id: "h-123",
      },
    ],
  });

  test("a worker PASS with a verifier parity_exit nonzero is not green", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({
          ran: true,
          check_exit: 0,
          parity_exit: 1,
          failing_segment: "bun run check:ci",
          output_tail: "lint:strict failed",
        }),
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.check_verify_status).toBe("failed");
    expect(rounds?.[0]?.passed).toBe(false);
    expect(rounds?.[0]?.ci_parity).toBe(false);
    expect(result?.ci_parity).toBe(false);
  });

  test("a worker PASS with check_exit 0 and parity_exit 0 is green with ci_parity true", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0, parity_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.verified).toBe(true);
    expect(rounds?.[0]?.ci_parity).toBe(true);
    expect(result?.ci_parity).toBe(true);
  });

  test("a verifier that omits parity_exit fails closed when parityCheck is set", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.ci_parity).toBe(false);
    expect(result?.ci_parity).toBe(false);
  });

  test("the verify prompt runs the parity command verbatim via bash -c", async () => {
    const { agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0, parity_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("bash -c 'bun run check:ci'");
    expect(verifyCall!.prompt).toContain("parity_exit");
  });

  test("without parityCheck the verifier prompt and results carry no parity state", async () => {
    const { result, agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    expect(result?.green).toBe(true);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.ci_parity).toBe(false);
    expect(result?.ci_parity).toBe(false);
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).not.toContain("parity_exit");
    expect(verifyCall!.prompt).not.toContain("PARITY command");
  });

  test("parityCheck with verifyCheck:false is rejected before any dispatch", async () => {
    const { result, error, workflowCalls, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        verifyCheck: false,
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => {
          throw new Error("agent should not be called");
        },
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("parity_check_requires_verify_check");
    expect(workflowCalls).toHaveLength(0);
    expect(agentCalls).toHaveLength(0);
  });

  test("the round message includes the parity command when parityCheck is set", async () => {
    const { workflowCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      { workflow: async () => ({}) },
    );

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const message = (fanout!.args as FanoutArgs).tasks[0]?.message;
    expect(message).toContain("bash -c 'bun run check:ci'");
    expect(message).toContain("BOTH");
  });

  test("the round message is byte-for-byte unchanged when parityCheck is not set", async () => {
    const { workflowCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      { workflow: async () => ({}) },
    );

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const message = (fanout!.args as FanoutArgs).tasks[0]?.message;
    expect(message).toBe(
      [
        "m",
        "",
        "When done, run this check in the repo by spawning bash with the command as a single argument:",
        "    bash -c 'bun run typecheck'",
        "If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.",
        "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
      ].join("\n"),
    );
  });

  test("a parity failure's output reaches the next round message", async () => {
    const verifierResults = [
      {
        ran: true,
        check_exit: 0,
        parity_exit: 1,
        failing_segment: "bun run check:ci",
        output_tail: "lint:strict failed",
      },
      { ran: true, check_exit: 0, parity_exit: 0 },
    ];
    let verifyCallIndex = 0;
    const { result, workflowCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 2,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => verifierResults[Math.min(verifyCallIndex++, verifierResults.length - 1)],
      },
    );

    expect(error).toBeUndefined();
    expect(result?.ok).toBe(true);
    expect(result?.green).toBe(true);
    const fanoutCalls = workflowCalls.filter((call) => call.name === "penumbra-fanout");
    expect(fanoutCalls).toHaveLength(2);
    const secondMessage = (fanoutCalls[1]!.args as FanoutArgs).tasks[0]?.message;
    expect(secondMessage).toContain("Last failure output:");
    expect(secondMessage).toContain("lint:strict failed");
  });

  test("the verifier prompt budgets the parity command's runtime", async () => {
    const { agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0, parity_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("7 minutes");
    expect(verifyCall!.prompt).toContain("background");
    expect(verifyCall!.prompt).toContain("poll");
    expect(verifyCall!.prompt).toContain("before the PARITY command has exited");
    // A single Bash call is capped at 10 minutes; asking for a 15-minute
    // timeout makes the verifier request something the tool cannot grant.
    expect(verifyCall!.prompt).not.toContain("15 minutes");
    expect(verifyCall!.prompt).not.toContain("timeout of at least");
  });

  test("the verifier prompt sources failure evidence from the parity run", async () => {
    const { agentCalls, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "bun run typecheck",
        parityCheck: "bun run check:ci",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: trustworthyPassFanout,
        agent: async () => ({ ran: true, check_exit: 0, parity_exit: 0 }),
      },
    );

    expect(error).toBeUndefined();
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("PARITY run");
  });
});

describe("penumbra-fix-until-green missing fanout proxy", () => {
  const missingProxyStub = async () => ({
    results: [
      {
        ok: false,
        status: "proxy_error",
        error_code: "not_found",
        label: "t0",
        index: 0,
        error_summary: "proxy_error: agent type penumbra:penumbra-fanout-proxy not found",
      },
    ],
  });

  test("stops round 1 with proxy_not_installed and an actionable hint", async () => {
    const { result, workflowCalls, logs, error } = await runFixUntilGreen(
      { task: { message: "m" }, check: "true", maxRounds: 3, repo: "/repo" },
      { workflow: missingProxyStub },
    );
    expect(error).toBeUndefined();
    const rounds = (result?.rounds as Round[]) ?? [];
    expect(result?.green).toBe(false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.reason).toBe("proxy_not_installed");
    expect(rounds[0]?.hint).toContain("penumbra:penumbra-fanout-proxy");
    expect(rounds[0]?.hint).toContain("agentType: 'inherit'");
    expect(result?.last_output).toBe(rounds[0]?.hint);
    expect(workflowCalls.filter((call) => call.name === "penumbra-fanout")).toHaveLength(1);
    expect(
      logs.some(
        (entry) => entry.includes("proxy_not_installed") && entry.includes("agentType: 'inherit'"),
      ),
    ).toBe(true);
  });

  test("explicit agentType keeps a missing proxy as no_dispatch without a hint", async () => {
    const { result, error } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 3,
        repo: "/repo",
        agentType: "custom:proxy",
      },
      { workflow: missingProxyStub },
    );
    expect(error).toBeUndefined();
    const rounds = (result?.rounds as Round[]) ?? [];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.reason).toBe("no_dispatch");
    expect(rounds[0]?.hint).toBeUndefined();
  });

  test("a denied proxy keeps no_dispatch without a hint", async () => {
    const { result, error } = await runFixUntilGreen(
      { task: { message: "m" }, check: "true", maxRounds: 3, repo: "/repo" },
      {
        workflow: async () => ({
          results: [
            {
              ok: false,
              status: "proxy_error",
              error_code: "denied",
              label: "t0",
              index: 0,
              error_summary: "proxy_error: denied",
            },
          ],
        }),
      },
    );
    expect(error).toBeUndefined();
    const rounds = (result?.rounds as Round[]) ?? [];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.reason).toBe("no_dispatch");
    expect(rounds[0]?.hint).toBeUndefined();
  });
});

describe("penumbra-fix-until-green rubric grader scope", () => {
  const graderScopeFanout = async () => ({
    results: [
      {
        ok: true,
        status: "completed",
        branch: "test/x_h-777",
        conversation_id: "c",
        handoff_id: "h-777",
        reliability_trustworthy: true,
        check_line: "CHECK_RESULT: PASS",
      },
    ],
  });

  function graderStub(value: unknown) {
    return async (_prompt: string, options?: Record<string, unknown>) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("verify-check")) return { ran: true, check_exit: 0 };
      if (label.startsWith("rubric")) return value;
      return {};
    };
  }

  test("grader prompt is scoped to the dispatch repo, not its own cwd", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        repo: "/srv/other-repo",
        base: "feat/base",
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          inspected: true,
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "diff" }],
        }),
      },
    );

    expect(result?.green).toBe(true);
    const prompt = agentCalls.find((c) =>
      String(c.options?.label ?? "").startsWith("rubric"),
    )!.prompt;
    expect(prompt).toContain("Repository root: /srv/other-repo");
    expect(prompt).toContain("/srv/other-repo-worktrees/h-777");
    expect(prompt).toContain("git -C /srv/other-repo diff --stat feat/base...test/x_h-777");
    expect(prompt).toContain('mcp__penumbra__worktree_inspect({ handoff_id: "h-777" })');
    expect(prompt).not.toMatch(/\bgit (?!-C )/);
  });

  test("grader prompt uses caller_cwd as repo root when repo is absent", async () => {
    const { agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          inspected: true,
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "diff" }],
        }),
      },
    );

    const prompt = agentCalls.find((c) =>
      String(c.options?.label ?? "").startsWith("rubric"),
    )!.prompt;
    expect(prompt).toContain("git -C /abs diff --stat main...test/x_h-777");
  });

  test("grader returning inspected:false yields GRADER_UNAVAILABLE without a second round", async () => {
    const { result, workflowCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 2,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({ inspected: false, criteria: [], notes: "branch not found" }),
      },
    );

    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds).toHaveLength(1);
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    expect(rounds?.[0]?.passed).toBe(false);
    const fanoutCalls = workflowCalls.filter((c) => c.name === "penumbra-fanout");
    expect(fanoutCalls).toHaveLength(1);
  });

  test("grader returning undefined yields GRADER_UNAVAILABLE", async () => {
    const { result, workflowCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 2,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub(undefined),
      },
    );

    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    const fanoutCalls = workflowCalls.filter((c) => c.name === "penumbra-fanout");
    expect(fanoutCalls).toHaveLength(1);
  });
});

describe("penumbra-fix-until-green reply without a CHECK_RESULT marker", () => {
  const noMarkerFanout = async () => ({
    results: [
      {
        ok: true,
        status: "completed",
        branch: "feat/x",
        conversation_id: "c",
        handoff_id: "h-123",
        reliability_trustworthy: true,
        check_line: "I committed the change and the tests pass.",
      },
    ],
  });

  test("an unknown verdict turns green only through an independent verifier pass", async () => {
    const { result, workflowCalls, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 3,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: noMarkerFanout,
        agent: async () => ({ ran: true, check_exit: 0 }),
      },
    );

    expect(result?.green).toBe(true);
    expect(result?.rounds_used).toBe(1);
    expect(workflowCalls.filter((call) => call.name === "penumbra-fanout")).toHaveLength(1);
    const verifyCall = agentCalls.find((call) =>
      String(call.options?.label ?? "").startsWith("verify-check"),
    );
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.prompt).toContain("no CHECK_RESULT line");
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.verified).toBe(true);
    expect(rounds?.[0]?.check_passed).toBe(false);
    expect(rounds?.[0]?.check_verify_status).toBe("passed");
  });

  test("an unknown verdict the verifier fails stays red", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: noMarkerFanout,
        agent: async () => ({
          ran: true,
          check_exit: 1,
          failing_segment: "true",
          output_tail: "boom",
        }),
      },
    );

    expect(result?.green).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.check_exit).toBe(1);
    expect(rounds?.[0]?.verified).toBe(false);
    expect(rounds?.[0]?.check_passed).toBe(false);
  });

  test("verifyCheck:false never green-lights an unknown verdict", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        verifyCheck: false,
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: noMarkerFanout,
        agent: async () => {
          throw new Error("agent should not be called");
        },
      },
    );

    expect(result?.green).toBe(false);
    expect(agentCalls).toHaveLength(0);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.passed).toBe(false);
  });

  test("an unknown verdict still gates on the rubric after a verifier pass", async () => {
    const { result, agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: noMarkerFanout,
        agent: async (_prompt, options) => {
          if (String(options?.label ?? "").startsWith("verify-check"))
            return { ran: true, check_exit: 0 };
          if (String(options?.label ?? "").startsWith("rubric"))
            return {
              inspected: true,
              overall_pass: false,
              criteria: [
                { index: 1, criterion: "criterion one", pass: false, evidence: "missing" },
              ],
            };
          return {};
        },
      },
    );

    expect(result?.green).toBe(false);
    expect(agentCalls.some((call) => String(call.options?.label ?? "").startsWith("rubric"))).toBe(
      true,
    );
  });
});

describe("penumbra-fix-until-green rubric grader schema and range", () => {
  const graderScopeFanout = async () => ({
    results: [
      {
        ok: true,
        status: "completed",
        branch: "test/x_h-777",
        conversation_id: "c",
        handoff_id: "h-777",
        reliability_trustworthy: true,
        check_line: "CHECK_RESULT: PASS",
      },
    ],
  });

  function graderStub(value: unknown) {
    return async (_prompt: string, options?: Record<string, unknown>) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("verify-check")) return { ran: true, check_exit: 0 };
      if (label.startsWith("rubric")) return value;
      return {};
    };
  }

  test("the rubric grader schema requires the inspected flag", async () => {
    const { agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          inspected: true,
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "d" }],
        }),
      },
    );

    const rubricCall = agentCalls.find((c) => String(c.options?.label ?? "").startsWith("rubric"));
    expect(rubricCall).toBeDefined();
    const schema = rubricCall!.options?.schema as Record<string, unknown>;
    expect(schema.required as string[]).toContain("inspected");
    expect((schema.properties as Record<string, Record<string, unknown>>).inspected!.type).toBe(
      "boolean",
    );
  });

  test("the grader range uses defaults.branch_base when args.base is absent", async () => {
    const { agentCalls } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs", branch_base: "feat/d" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          inspected: true,
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "d" }],
        }),
      },
    );

    const prompt = agentCalls.find((c) =>
      String(c.options?.label ?? "").startsWith("rubric"),
    )!.prompt;
    expect(prompt).toContain("git -C /abs diff --stat feat/d...test/x_h-777");
  });
});

describe("penumbra-fix-until-green proxy hint session guidance", () => {
  test("the proxy hint tells the operator to start a new session", async () => {
    const missingProxyStub = async () => ({
      results: [
        {
          ok: false,
          status: "proxy_error",
          error_code: "not_found",
          label: "t0",
          index: 0,
          error_summary: "proxy_error: agent type penumbra:penumbra-fanout-proxy not found",
        },
      ],
    });

    const { result } = await runFixUntilGreen(
      { task: { message: "m" }, check: "true", maxRounds: 3, repo: "/repo" },
      { workflow: missingProxyStub },
    );

    const rounds = (result?.rounds as Round[]) ?? [];
    expect(rounds[0]?.hint).toContain("start a new Claude Code session");
  });
});

describe("penumbra-fix-until-green fails closed on an unattested grade or unmarked round", () => {
  const graderScopeFanout = async () => ({
    results: [
      {
        ok: true,
        status: "completed",
        branch: "test/x_h-777",
        conversation_id: "c",
        handoff_id: "h-777",
        reliability_trustworthy: true,
        check_line: "CHECK_RESULT: PASS",
      },
    ],
  });

  function graderStub(value: unknown) {
    return async (_prompt: string, options?: Record<string, unknown>) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("verify-check")) return { ran: true, check_exit: 0 };
      if (label.startsWith("rubric")) return value;
      return {};
    };
  }

  test("a passing grade with no inspected key yields GRADER_UNAVAILABLE", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 2,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "d" }],
        }),
      },
    );

    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    expect(result?.green).toBe(false);
  });

  test("a passing grade with inspected:null yields GRADER_UNAVAILABLE", async () => {
    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 2,
        rubric: ["criterion one"],
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: graderScopeFanout,
        agent: graderStub({
          inspected: null,
          overall_pass: true,
          criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "d" }],
        }),
      },
    );

    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.rubric_status).toBe("GRADER_UNAVAILABLE");
    expect(result?.green).toBe(false);
  });

  test("an unmarked round whose verifier is unavailable says no CHECK_RESULT marker, not worker PASS", async () => {
    const noMarkerFanout = async () => ({
      results: [
        {
          ok: true,
          status: "completed",
          branch: "feat/x",
          conversation_id: "c",
          handoff_id: "h-123",
          reliability_trustworthy: true,
          check_line: "I committed the change.",
        },
      ],
    });

    const { result } = await runFixUntilGreen(
      {
        task: { message: "m" },
        check: "true",
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      {
        workflow: noMarkerFanout,
        agent: async () => null,
      },
    );

    const lastOutput = String(result?.last_output ?? "");
    expect(lastOutput).toContain("no CHECK_RESULT marker");
    expect(lastOutput).not.toContain("worker's PASS");
  });
});
