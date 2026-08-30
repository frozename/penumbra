import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const WORKFLOWS = [
  {
    path: ".claude/workflows/penumbra-fanout.js",
    name: "penumbra-fanout",
    topLevelAllowedKeys: ["tasks", "defaults", "agentType", "dispatcherModel"],
    defaultsAllowedKeys: [
      "initial_agent",
      "task_class",
      "task_type",
      "trust_mode",
      "use_worktree",
      "max_hops",
      "timeout_ms",
      "task_name",
      "branch_type",
      "branch_base",
    ],
    taskAllowedKeys: [
      "label",
      "name",
      "title",
      "task_name",
      "branch_type",
      "initial_agent",
      "task_class",
      "task_type",
      "trust_mode",
      "use_worktree",
      "max_hops",
      "timeout_ms",
      "message",
      "branch_base",
    ],
    taskRequiredKeys: ["message"],
    validInput: { tasks: [{ message: "do the work" }] },
  },
  {
    path: ".claude/workflows/penumbra-fleet-verify.js",
    name: "penumbra-fleet-verify",
    topLevelAllowedKeys: ["tasks", "repo"],
    taskAllowedKeys: [
      "name",
      "dispatchPrompt",
      "agent",
      "taskClass",
      "verifyChecklist",
      "branchBase",
      "task_name",
      "label",
      "title",
      "branch_type",
    ],
    taskRequiredKeys: ["name", "dispatchPrompt"],
    validInput: { tasks: [{ name: "one", dispatchPrompt: "do the work" }] },
  },
  {
    path: ".claude/workflows/penumbra-swarm.js",
    name: "penumbra-swarm",
    topLevelAllowedKeys: [
      "goal",
      "maxTasks",
      "defaults",
      "agentType",
      "plannerModel",
      "dispatcherModel",
    ],
    defaultsAllowedKeys: [
      "initial_agent",
      "task_class",
      "task_type",
      "trust_mode",
      "use_worktree",
      "max_hops",
      "timeout_ms",
      "task_name",
      "branch_type",
      "branch_base",
    ],
    taskAllowedKeys: [
      "label",
      "task_name",
      "branch_type",
      "initial_agent",
      "task_class",
      "task_type",
      "message",
      "rationale",
    ],
    taskRequiredKeys: ["task_class", "task_type", "message"],
    validInput: { goal: "ship it", defaults: { task_class: "STANDARD" } },
    validTasks: [{ task_class: "STANDARD", task_type: "implement_small", message: "do the work" }],
    taskLocationPrefix: "plan.tasks",
  },
  {
    path: ".claude/workflows/penumbra-fix-until-green.js",
    name: "penumbra-fix-until-green",
    topLevelAllowedKeys: [
      "task",
      "check",
      "rubric",
      "agent",
      "escalateTo",
      "maxRounds",
      "base",
      "defaults",
      "dispatcherModel",
      "graderModel",
    ],
    defaultsAllowedKeys: [
      "initial_agent",
      "task_class",
      "task_type",
      "trust_mode",
      "use_worktree",
      "max_hops",
      "timeout_ms",
      "task_name",
      "branch_type",
      "branch_base",
    ],
    taskAllowedKeys: [
      "message",
      "task_name",
      "label",
      "name",
      "title",
      "branch_type",
      "task_class",
      "task_type",
    ],
    taskRequiredKeys: ["message"],
    validInput: { task: { message: "do the work" }, check: "bun test" },
    taskLocationPrefix: "task",
  },
];

function readValidatorBlock(path: string): string {
  const source = readFileSync(resolve(path), "utf8");
  const match = source.match(
    /\/\/ task-spec-validation:begin\n([\s\S]*?)\/\/ task-spec-validation:end/,
  );
  expect(match, `${path} should include the task-spec validator block`).not.toBeNull();
  return match![1];
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("unterminated export const meta object");
}

function readRuntimeBody(path: string): string {
  const source = readFileSync(resolve(path), "utf8");
  const marker = "export const meta";
  const start = source.indexOf(marker);
  expect(start, `${path} should include export const meta`).toBeGreaterThanOrEqual(0);
  const equals = source.indexOf("=", start + marker.length);
  expect(equals, `${path} should assign export const meta`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", equals);
  expect(open, `${path} should assign an object literal to meta`).toBeGreaterThanOrEqual(0);
  const close = findMatchingBrace(source, open);
  const after = source[close + 1] === ";" ? close + 2 : close + 1;

  return source.slice(0, start) + source.slice(after);
}

async function runWorkflow(
  path: string,
  args: unknown,
): Promise<{ agentCalls: number; error?: unknown }> {
  const body = readRuntimeBody(path);
  const calls = { agent: 0 };
  const agent = async () => {
    calls.agent++;
    return {};
  };
  const parallel = async (items: unknown[]) => Promise.all(items.map((item) => item));
  const pipeline = async (...items: unknown[]) => items.at(-1);
  const phase = async (_name: string, fn?: () => unknown) => (fn ? fn() : undefined);
  const log = () => {};
  const budget = {};
  const workflow = async () => ({});
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
    agent: typeof agent,
    parallel: typeof parallel,
    pipeline: typeof pipeline,
    phase: typeof phase,
    log: typeof log,
    args: unknown,
    budget: typeof budget,
    workflow: typeof workflow,
  ) => Promise<unknown>;

  try {
    await run(agent, parallel, pipeline, phase, log, args, budget, workflow);
  } catch (error) {
    return { agentCalls: calls.agent, error };
  }
  return { agentCalls: calls.agent };
}

async function invokeWorkflow(path: string, args: unknown): Promise<{ agentCalls: number }> {
  const result = await runWorkflow(path, args);
  if (result.error) throw result.error;
  return { agentCalls: result.agentCalls };
}

const blocks = WORKFLOWS.map((workflow) => readValidatorBlock(workflow.path));
const validateSpec = new Function(`${blocks[0]}\nreturn validateSpec`)() as (
  spec: Record<string, unknown>,
) => void;

describe("workflow task-spec validation block", () => {
  test("is textually identical in every guarded workflow", () => {
    expect(new Set(blocks).size).toBe(1);
  });

  for (const workflow of WORKFLOWS) {
    test(`${workflow.name} rejects unknown task keys`, () => {
      const tasks = workflow.validTasks ?? [
        { ...workflow.validInput.task, typo_agent: "codex-acp-fast" },
      ];
      const invalidTasks = workflow.validTasks
        ? [{ ...workflow.validTasks[0], typo_agent: "codex-acp-fast" }]
        : tasks;

      expect(() =>
        validateSpec({
          workflowName: workflow.name,
          input: workflow.validInput,
          topLevelAllowedKeys: workflow.topLevelAllowedKeys,
          defaultsAllowedKeys: workflow.defaultsAllowedKeys,
          taskAllowedKeys: workflow.taskAllowedKeys,
          taskRequiredKeys: workflow.taskRequiredKeys,
          tasks: invalidTasks,
          taskLocationPrefix: workflow.taskLocationPrefix,
        }),
      ).toThrow(
        new RegExp(
          `${workflow.name}: unknown key "typo_agent".*allowed keys:.*${workflow.taskAllowedKeys.at(-1)}`,
        ),
      );
    });

    test(`${workflow.name} accepts a valid spec`, () => {
      validateSpec({
        workflowName: workflow.name,
        input: workflow.validInput,
        topLevelAllowedKeys: workflow.topLevelAllowedKeys,
        defaultsAllowedKeys: workflow.defaultsAllowedKeys,
        taskAllowedKeys: workflow.taskAllowedKeys,
        taskRequiredKeys: workflow.taskRequiredKeys,
        tasks: workflow.validTasks ?? [workflow.validInput.task ?? workflow.validInput.tasks[0]],
        taskLocationPrefix: workflow.taskLocationPrefix,
      });
    });

    test(`${workflow.name} rejects missing required task keys`, () => {
      const missingKey = workflow.taskRequiredKeys[0];
      const validTask =
        workflow.validTasks?.[0] ?? workflow.validInput.task ?? workflow.validInput.tasks[0];
      const invalidTask = { ...validTask };
      delete invalidTask[missingKey];

      expect(() =>
        validateSpec({
          workflowName: workflow.name,
          input: workflow.validInput,
          topLevelAllowedKeys: workflow.topLevelAllowedKeys,
          defaultsAllowedKeys: workflow.defaultsAllowedKeys,
          taskAllowedKeys: workflow.taskAllowedKeys,
          taskRequiredKeys: workflow.taskRequiredKeys,
          tasks: [invalidTask],
          taskLocationPrefix: workflow.taskLocationPrefix,
        }),
      ).toThrow(new RegExp(`${workflow.name}: missing required key "${missingKey}"`));
    });
  }

  test("fix-until-green rejects unknown top-level args keys", () => {
    const workflow = WORKFLOWS.find((item) => item.name === "penumbra-fix-until-green")!;

    expect(() =>
      validateSpec({
        workflowName: workflow.name,
        input: { ...workflow.validInput, unknown_base: "main" },
        topLevelAllowedKeys: workflow.topLevelAllowedKeys,
        defaultsAllowedKeys: workflow.defaultsAllowedKeys,
        taskAllowedKeys: workflow.taskAllowedKeys,
        taskRequiredKeys: workflow.taskRequiredKeys,
        tasks: [workflow.validInput.task],
        taskLocationPrefix: workflow.taskLocationPrefix,
      }),
    ).toThrow(/penumbra-fix-until-green: unknown key "unknown_base" at args/);
  });

  for (const workflow of WORKFLOWS) {
    test(`${workflow.name} invokes validation before agent dispatch`, async () => {
      const result = await runWorkflow(workflow.path, {
        ...workflow.validInput,
        unknown_top_key: true,
      });

      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(
        new RegExp(`${workflow.name}: unknown key "unknown_top_key" at args`),
      );
      expect(result.agentCalls).toBe(0);
    });
  }

  for (const workflowName of ["penumbra-fanout", "penumbra-fleet-verify"]) {
    test(`${workflowName} requires top-level tasks during runtime invocation`, async () => {
      const workflow = WORKFLOWS.find((item) => item.name === workflowName)!;

      await expect(invokeWorkflow(workflow.path, {})).rejects.toThrow(
        new RegExp(`${workflowName}: missing required key "tasks" at args; allowed keys:.*tasks`),
      );
    });
  }

  test("checker parses workflow metadata without invoking constructed functions", () => {
    const source = readFileSync(resolve("scripts/check-workflow-scripts.ts"), "utf8");

    expect(source.split("\n").filter((line) => /new Function\(.*\)\s*\(\)/.test(line))).toEqual([]);
  });

  test("checker requires top-level metadata strings", () => {
    const root = mkdtempSync(resolve(tmpdir(), "penumbra-workflow-check-"));
    const workflowDir = resolve(root, ".claude/workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      resolve(workflowDir, "invalid.js"),
      `export const meta = {
  phases: [{ name: "nested" }],
  description: "valid description",
};
`,
    );

    const result = Bun.spawnSync({
      cmd: ["bun", resolve("scripts/check-workflow-scripts.ts")],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(root, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("meta.name must be a non-empty string");
  });

  test("checker accepts valid top-level metadata strings", () => {
    const root = mkdtempSync(resolve(tmpdir(), "penumbra-workflow-check-"));
    const workflowDir = resolve(root, ".claude/workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      resolve(workflowDir, "valid.js"),
      `export const meta = {
  name: "valid workflow",
  description: "valid description",
  phases: [{ name: "nested" }],
};
`,
    );

    const result = Bun.spawnSync({
      cmd: ["bun", resolve("scripts/check-workflow-scripts.ts")],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(root, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
  });

  test("checker passes the current workflow scripts", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "scripts/check-workflow-scripts.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
  });
});
