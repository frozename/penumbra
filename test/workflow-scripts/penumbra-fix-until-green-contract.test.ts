import { describe, expect, test } from "bun:test";

import { readRuntimeBody, runWorkflowCapturingPrompts } from "./harness.js";

const FIX_UNTIL_GREEN = ".claude/workflows/penumbra-fix-until-green.js";

interface FanoutArgs {
  tasks: Array<Record<string, unknown>>;
  defaults?: Record<string, unknown>;
  dispatcherModel?: string;
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
          results: [{ ok: false, reliability_trustworthy: true, label: "t0", index: 0 }],
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
          results: [{ ok: true, reliability_trustworthy: true, label: "t0", index: 0 }],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("completed_no_branch");
  });

  test("untrustworthy_dispatch when reliability_trustworthy is false", async () => {
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
            { ok: true, branch: "feat/x", reliability_trustworthy: false, label: "t0", index: 0 },
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
          results: [{ ok: true, branch: "feat/x", label: "t0", index: 0 }],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("untrustworthy_dispatch");
    expect(logs.some((log) => log.includes("never audited"))).toBe(true);
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
