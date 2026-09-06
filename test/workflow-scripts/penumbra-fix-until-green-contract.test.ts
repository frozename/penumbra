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
}

interface FixUntilGreenResult {
  result: Record<string, unknown> | undefined;
  workflowCalls: Array<{ name: string; args: unknown }>;
  agentCalls: Array<{ prompt: string; options?: Record<string, unknown> }>;
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
  const log = () => {};

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
    return { result, workflowCalls, agentCalls };
  } catch (error) {
    return { result: undefined, workflowCalls, agentCalls, error };
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
            { ok: true, branch: "feat/x", reliability_trustworthy: false, label: "t0", index: 0 },
          ],
        }),
      },
    );

    expect(result?.ok).toBe(false);
    const rounds = result?.rounds as Round[] | undefined;
    expect(rounds?.[0]?.reason).toBe("untrustworthy_dispatch");
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
          results: [{ ok: true, branch: "feat/x", check_line: "CHECK_RESULT: PASS" }],
        }),
        agent: async (_prompt, options) => {
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
              response: "Here is some narrative\n\nCHECK_RESULT: PASS\n",
            },
          ],
        }),
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
