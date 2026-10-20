import { describe, expect, test } from "bun:test";

import { readRuntimeBody, runWorkflowCapturingPrompts } from "./harness.js";

const LOOP = ".claude/workflows/penumbra-loop-discover-to-green.js";
const TOURNAMENT = ".claude/workflows/penumbra-tournament.js";

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
type WorkflowStub = (name: string, wArgs: unknown) => Promise<unknown>;

async function runWithStubs(
  path: string,
  args: unknown,
  {
    agentStub = async () => ({}),
    workflowStub = async () => ({}),
  }: { agentStub?: AgentStub; workflowStub?: WorkflowStub } = {},
): Promise<{
  result: unknown;
  prompts: string[];
  workflowCalls: Array<{ name: string; args: unknown }>;
  logs: string[];
  error?: unknown;
}> {
  const body = readRuntimeBody(path);
  const prompts: string[] = [];
  const workflowCalls: Array<{ name: string; args: unknown }> = [];
  const logs: string[] = [];

  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    prompts.push(String(prompt));
    return agentStub(prompt, options);
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
  const log = (msg: unknown) => {
    logs.push(String(msg));
  };
  const budget = {};
  const workflow = async (name: string, wArgs: unknown) => {
    workflowCalls.push({ name, args: wArgs });
    return workflowStub(name, wArgs);
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
  ) as (...fns: unknown[]) => Promise<unknown>;

  try {
    const result = await run(agent, parallel, pipeline, phase, log, args, budget, workflow);
    return { result, prompts, workflowCalls, logs };
  } catch (error) {
    return { result: undefined, prompts, workflowCalls, logs, error };
  }
}

function fanoutCall(calls: Array<{ name: string; args: unknown }>) {
  return calls.find((c) => c.name === "penumbra-fanout");
}

function reviewCall(calls: Array<{ name: string; args: unknown }>) {
  return calls.find((c) => c.name === "adversarial-review");
}

const LONG_TITLE = "a".repeat(160);
const SEED = {
  title: LONG_TITLE,
  severity: "MEDIUM",
  file: "src/x.ts:1",
  why_real: "it breaks",
  fix_sketch: "fix it",
  suggested_check: "bun test",
  confidence: "high",
};

const PLAN = {
  summary: "fix the bug",
  files: "src/x.ts",
  check_command: "bun test src/x.ts",
  spec: "make it right",
};

describe("penumbra-loop-discover-to-green forwarding", () => {
  test("a.defaults reaches penumbra-fanout", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(LOOP, {
      repo: "/tmp/pen",
      seedCandidates: [SEED],
      defaults: {
        isolated_install: false,
        use_worktree: false,
        trust_mode: "config",
      },
    });

    expect(error).toBeUndefined();
    const fanout = fanoutCall(workflowCalls);
    expect(fanout).toBeDefined();
    const defaults = (fanout!.args as { defaults?: Record<string, unknown> }).defaults;
    expect(defaults?.isolated_install).toBe(false);
    expect(defaults?.use_worktree).toBe(false);
    expect(defaults?.trust_mode).toBe("config");
  });

  test("a missing or relative repo fails closed before dispatch", async () => {
    const missing = await runWorkflowCapturingPrompts(LOOP, {
      seedCandidates: [SEED],
    });
    expect(missing.error).toBeDefined();
    expect(String(missing.error)).toMatch(/args\.repo must be an absolute path/);
    expect(missing.prompts).toHaveLength(0);

    const relative = await runWorkflowCapturingPrompts(LOOP, {
      repo: "relative/path",
      seedCandidates: [SEED],
    });
    expect(relative.error).toBeDefined();
    expect(String(relative.error)).toMatch(/args\.repo must be an absolute path/);
    expect(relative.prompts).toHaveLength(0);
  });

  test("a non-JSON args string throws instead of becoming the scope", async () => {
    const result = await runWorkflowCapturingPrompts(LOOP, "not valid json");

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain(
      "penumbra-loop-discover-to-green: args was a string but not valid JSON",
    );
    expect(result.prompts).toHaveLength(0);
  });

  test("a 160-char title is clamped to 120 before reaching fanout", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(LOOP, {
      repo: "/tmp/pen",
      seedCandidates: [SEED],
    });

    expect(error).toBeUndefined();
    const fanout = fanoutCall(workflowCalls);
    expect(fanout).toBeDefined();
    const tasks = (fanout!.args as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
    expect(tasks).toHaveLength(1);
    const taskName = String(tasks[0]!.task_name ?? "");
    expect(taskName).toHaveLength(120);
    expect(taskName).toBe(LONG_TITLE.slice(0, 120));
  });

  test("adversarial-review call carries the absolute repo", async () => {
    const { workflowCalls, error } = await runWithStubs(
      LOOP,
      {
        repo: "/abs/repo",
        seedCandidates: [SEED],
      },
      {
        agentStub: async (_prompt, options) => {
          if (options?.label === "plan") return PLAN;
          return {};
        },
        workflowStub: async (name) => {
          if (name === "penumbra-fanout") {
            return {
              results: [
                {
                  ok: true,
                  branch: "green-branch",
                  handoff_id: "h1",
                  response: "CHECK_RESULT: PASS\n",
                },
              ],
            };
          }
          if (name === "adversarial-review") {
            return {
              outcome: "success",
              verdict: "land",
              high_count: 0,
              completed_personas: ["p"],
              land_candidate: "green-branch",
            };
          }
          return {};
        },
      },
    );

    expect(error).toBeUndefined();
    const review = reviewCall(workflowCalls);
    expect(review).toBeDefined();
    expect((review!.args as { repo?: string }).repo).toBe("/abs/repo");
  });
});

describe("penumbra-tournament forwarding", () => {
  test("spreads the caller's task and forwards isolated_install/branch_base/response_mode", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(TOURNAMENT, {
      task: {
        message: "do the work",
        isolated_install: false,
        branch_base: "main",
        response_mode: "first_line",
        use_worktree: false,
      },
      agents: ["codex-acp-fast", "gemini-acp-fast"],
      defaults: { project_id: "penumbra" },
    });

    expect(error).toBeUndefined();
    const fanout = fanoutCall(workflowCalls);
    expect(fanout).toBeDefined();
    const tasks = (fanout!.args as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t!.isolated_install).toBe(false);
      expect(t!.branch_base).toBe("main");
      expect(t!.response_mode).toBe("first_line");
      expect(t!.use_worktree).toBe(true);
    }
  });

  test("logs a warning when overriding task.use_worktree=false", async () => {
    const { workflowCalls, logs, error } = await runWithStubs(
      TOURNAMENT,
      {
        task: {
          message: "do the work",
          use_worktree: false,
        },
        agents: ["codex-acp-fast"],
        defaults: { project_id: "penumbra" },
      },
      {
        workflowStub: async () => ({ results: [] }),
      },
    );

    expect(error).toBeUndefined();
    const fanout = fanoutCall(workflowCalls);
    expect(fanout).toBeDefined();
    const tasks = (fanout!.args as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
    expect(tasks[0]?.use_worktree).toBe(true);
    expect(logs.some((line) => /overriding task\.use_worktree=false/.test(line))).toBe(true);
  });

  test("a non-JSON args string throws", async () => {
    const result = await runWorkflowCapturingPrompts(TOURNAMENT, "not valid json");

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain(
      "penumbra-tournament: args was a string but not valid JSON",
    );
    expect(result.prompts).toHaveLength(0);
  });
});

for (const [path, input] of [
  [LOOP, { repo: "/repo", seedCandidates: [SEED] }],
  [TOURNAMENT, { task: { message: "work" }, agents: ["executor"], repo: "/repo" }],
] as const) {
  for (const agentType of [undefined, "inherit", "penumbra:penumbra-fanout-proxy"]) {
    test(`${path} forwards agentType ${String(agentType)} only when supplied`, async () => {
      const { workflowCalls, error } = await runWorkflowCapturingPrompts(path, {
        ...input,
        ...(agentType !== undefined ? { agentType } : {}),
      });
      expect(error).toBeUndefined();
      const forwarded = fanoutCall(workflowCalls)?.args as Record<string, unknown>;
      expect(forwarded).toBeDefined();
      if (agentType === undefined) expect(forwarded).not.toHaveProperty("agentType");
      else expect(forwarded.agentType).toBe(agentType);
    });
  }
}
