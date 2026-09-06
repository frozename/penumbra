import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ChainStartInputShape } from "../../packages/mcp/src/tools/chain-start.js";

const WORKFLOWS = [
  {
    path: ".claude/workflows/penumbra-fanout.js",
    name: "penumbra-fanout",
    topLevelAllowedKeys: ["tasks", "defaults", "agentType", "dispatcherModel", "repo"],
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
      "response_mode",
      "project_id",
      "caller_cwd",
      "isolated_install",
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
      "response_mode",
      "project_id",
      "caller_cwd",
      "isolated_install",
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
      "isolated_install",
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
      "project_id",
      "caller_cwd",
      "repo",
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
      "response_mode",
      "project_id",
      "caller_cwd",
      "isolated_install",
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
      "project_id",
      "caller_cwd",
      "repo",
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
      "response_mode",
      "project_id",
      "caller_cwd",
      "isolated_install",
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
      "response_mode",
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

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
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
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("unterminated export const meta object");
}

function findMatchingBrace(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "{", "}");
}

function findMatchingBracket(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "[", "]");
}

// Extracts the literal `name: ['a', 'b']` array declared in a workflow script so
// the WORKFLOWS fixture can be checked against the source instead of drifting as
// an unverified third copy. Returns null when the script declares no such array.
function readNamedArray(path: string, name: string): string[] | null {
  const source = readFileSync(resolve(path), "utf8");
  const matches = [...source.matchAll(new RegExp(`\\b${name}\\s*:\\s*\\[`, "g"))];
  if (matches.length === 0) return null;
  expect(matches.length, `${path} should declare ${name} exactly once`).toBe(1);
  const open = matches[0]!.index + matches[0]![0].length - 1;
  const close = findMatchingBracket(source, open);
  const body = source
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
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

// Unlike runWorkflow, this harness invokes the thunks fanout hands to `parallel`
// (the existing stub resolves the closures without calling them, so no dispatch
// prompt ever reaches the agent stub) and records nested `workflow(...)` calls
// so forwarders (fix-until-green / swarm -> penumbra-fanout) can be asserted on.
async function runWorkflowCapturingPrompts(
  path: string,
  args: unknown,
): Promise<{
  prompts: string[];
  workflowCalls: Array<{ name: string; args: unknown }>;
  error?: unknown;
}> {
  const body = readRuntimeBody(path);
  const prompts: string[] = [];
  const workflowCalls: Array<{ name: string; args: unknown }> = [];
  // A planner-shaped result keeps penumbra-swarm's planner stage producing a
  // valid task so the run reaches its workflow('penumbra-fanout', ...) handoff.
  const agent = async (prompt: string) => {
    prompts.push(String(prompt));
    return { tasks: [{ task_class: "STANDARD", task_type: "implement_small", message: "stub" }] };
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
  const budget = {};
  const workflow = async (name: string, wArgs: unknown) => {
    workflowCalls.push({ name, args: wArgs });
    return {};
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
  ) as (...a: unknown[]) => Promise<unknown>;

  try {
    await run(agent, parallel, pipeline, phase, log, args, budget, workflow);
  } catch (error) {
    return { prompts, workflowCalls, error };
  }
  return { prompts, workflowCalls };
}

function parseDispatchSpec(prompt: string): Record<string, unknown> {
  const m = prompt.match(/```dispatch\n([\s\S]*?)\n```/);
  if (!m || m[1] === undefined) throw new Error("no ```dispatch fence in prompt");
  return JSON.parse(m[1]) as Record<string, unknown>;
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

  test("penumbra-fanout rejects a scope-less dispatch before any agent call", async () => {
    const result = await runWorkflow(".claude/workflows/penumbra-fanout.js", {
      tasks: [{ message: "do the work" }],
    });

    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/no project scope resolved/);
    expect(result.agentCalls).toBe(0);
  });

  test("penumbra-fanout proceeds once project scope resolves", async () => {
    const scopedInputs = [
      { tasks: [{ message: "do the work" }], repo: "/tmp/penumbra-scope-pin" },
      { tasks: [{ message: "do the work" }], defaults: { project_id: "penumbra" } },
    ];

    for (const scopedInput of scopedInputs) {
      const result = await runWorkflow(".claude/workflows/penumbra-fanout.js", scopedInput);
      expect(result.error).toBeUndefined();
    }
  });

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

describe("isolated_install threading", () => {
  const FANOUT = ".claude/workflows/penumbra-fanout.js";
  const scopedArgs = {
    tasks: [{ message: "do the work" }],
    defaults: { project_id: "penumbra", isolated_install: false },
  };

  test("penumbra-fanout accepts isolated_install in defaults", async () => {
    const result = await runWorkflow(FANOUT, scopedArgs);

    expect(result.error).toBeUndefined();
  });

  test("penumbra-fanout dispatch spec carries isolated_install literal false", async () => {
    const { prompts } = await runWorkflowCapturingPrompts(FANOUT, scopedArgs);

    expect(parseDispatchSpec(prompts[0] ?? "").isolated_install).toBe(false);
  });

  test("penumbra-fanout protocol step 2 names isolated_install for the dispatch proxy", async () => {
    const { prompts } = await runWorkflowCapturingPrompts(FANOUT, scopedArgs);

    const step2 = String(prompts[0] ?? "")
      .split("\n")
      .find((line) => line.startsWith("2. Call mcp__penumbra__chain_start"));
    expect(step2 ?? "").toContain("isolated_install");
  });

  test("penumbra-fix-until-green forwards defaults.isolated_install to penumbra-fanout", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(
      ".claude/workflows/penumbra-fix-until-green.js",
      {
        task: { message: "do the work" },
        check: "true",
        defaults: { isolated_install: false, caller_cwd: "/abs/path" },
      },
    );

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    expect(
      (fanout!.args as { defaults?: Record<string, unknown> }).defaults?.isolated_install,
    ).toBe(false);
  });

  test("penumbra-swarm forwards defaults.isolated_install to penumbra-fanout", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(
      ".claude/workflows/penumbra-swarm.js",
      { goal: "ship it", defaults: { isolated_install: false, project_id: "penumbra" } },
    );

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    expect(
      (fanout!.args as { defaults?: Record<string, unknown> }).defaults?.isolated_install,
    ).toBe(false);
  });

  test("penumbra-fix-until-green still rejects isolated_install at task level", async () => {
    const result = await runWorkflow(".claude/workflows/penumbra-fix-until-green.js", {
      task: { message: "do the work", isolated_install: false },
      check: "true",
    });

    // fix-until-green's per-round dispatch task is a literal object that never
    // spreads `task`, so accepting the key here would silently drop it — the
    // loud rejection is the contract, not a gap.
    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(
      /penumbra-fix-until-green: unknown key "isolated_install" at task/,
    );
    expect(result.agentCalls).toBe(0);
  });

  test("penumbra-fleet-verify interpolates isolated_install=false into the dispatch prompt", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(
      ".claude/workflows/penumbra-fleet-verify.js",
      {
        tasks: [{ name: "one", dispatchPrompt: "do the work", isolated_install: false }],
        repo: "/abs/repo",
      },
    );

    expect(error).toBeUndefined();
    expect(prompts[0] ?? "").toContain("isolated_install=false");
  });

  test("penumbra-fleet-verify omits isolated_install from the prompt when not passed", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(
      ".claude/workflows/penumbra-fleet-verify.js",
      { tasks: [{ name: "one", dispatchPrompt: "do the work" }], repo: "/abs/repo" },
    );

    expect(error).toBeUndefined();
    expect(prompts[0] ?? "").not.toContain("isolated_install");
  });
});

// Workflow-local vocabulary that is legal in an allowlist but is not a
// chain_start param name. A key absent from ChainStartInputShape AND from this
// set (after alias resolution) is a typo that chain_start would silently ignore.
const WORKFLOW_LOCAL_KEYS = new Set([
  // orchestration args consumed by the script itself, never forwarded
  "tasks",
  "task",
  "defaults",
  "repo",
  "goal",
  "maxTasks",
  "check",
  "rubric",
  "escalateTo",
  "maxRounds",
  "base",
  "agentType",
  "dispatcherModel",
  "plannerModel",
  "graderModel",
  // display-name fallbacks resolved to task_name before dispatch
  "label",
  "name",
  "title",
  // swarm planner justification, stripped before the fanout call
  "rationale",
  // proxy-behavior keys: consumed by the dispatch prompt, not chain_start params
  "timeout_ms",
  "response_mode",
  // message is a real chain_start param but also the swarm planner field name
  "message",
  // fleet-verify: verifier checklist text, never dispatched
  "verifyChecklist",
]);

// camelCase (or otherwise divergent) workflow vocabulary mapped onto the real
// chain_start param it is interpolated as. penumbra-fleet-verify's public arg
// shape is documented camelCase and must not be renamed.
const KEY_ALIASES: Record<string, string> = {
  dispatchPrompt: "message",
  taskClass: "task_class",
  branchBase: "branch_base",
  agent: "initial_agent",
};

// The exact set of chain_start params no workflow expresses, each with a reason.
const NOT_EXPOSED: Record<string, string> = {
  open_pr_on_review: "outward action; a maxRounds loop would open N PRs; no blocked caller",
  tool_free: "no blocked caller — add on evidence",
  conversation_id:
    "every script starts a NEW chain and polls by the returned id; a caller-supplied id fuses N fanout tasks into one conversation and makes chain_get_response attribute another worker's answer to this task",
  parent_handoff_id:
    "inherits isolated_install: true per chains.ts resolveIsolatedInstall — re-introduces this very trap",
  workload: "alias for task_type; one spelling only",
  dispatch_kind: "self-written telemetry; a caller-stamped kind corrupts agent_performance",
  workflow_run_id: "server-issued exemption token per chain-start.ts — never allowlist",
  long_lived_agent_id: "server-issued identity",
  long_lived_tick_id: "server-issued identity",
};
const NOT_EXPOSED_EXPECTED_SIZE = 9;

const ALLOWLIST_NAMES = ["topLevelAllowedKeys", "defaultsAllowedKeys", "taskAllowedKeys"] as const;

function allowlistKeysFromSource(): Array<{ workflow: string; name: string; key: string }> {
  const rows: Array<{ workflow: string; name: string; key: string }> = [];
  for (const workflow of WORKFLOWS) {
    for (const name of ALLOWLIST_NAMES) {
      for (const key of readNamedArray(workflow.path, name) ?? []) {
        rows.push({ workflow: workflow.name, name, key });
      }
    }
  }
  return rows;
}

describe("workflow allowlists vs chain_start schema", () => {
  const CHAIN_START_KEYS = new Set(Object.keys(ChainStartInputShape));

  for (const workflow of WORKFLOWS) {
    test(`${workflow.name} fixture allowlists match the script source verbatim`, () => {
      for (const name of ALLOWLIST_NAMES) {
        const source = readNamedArray(workflow.path, name);
        const fixture = workflow[name] as string[] | undefined;
        if (fixture === undefined) {
          expect(
            source,
            `${workflow.name} declares ${name} in source but the WORKFLOWS fixture lacks it`,
          ).toBeNull();
          continue;
        }
        expect(
          source,
          `${workflow.name} fixture lists ${name} but the script does not declare it`,
        ).not.toBeNull();
        expect([...source!].sort()).toEqual([...fixture].sort());
      }
    });
  }

  test("KEY_ALIASES targets are real chain_start params", () => {
    for (const [alias, target] of Object.entries(KEY_ALIASES)) {
      expect(CHAIN_START_KEYS.has(target), `KEY_ALIASES.${alias} -> ${target}`).toBe(true);
    }
  });

  test("every allowlist key resolves to a chain_start param, an alias, or a declared local key", () => {
    const unknown: string[] = [];
    for (const row of allowlistKeysFromSource()) {
      if (CHAIN_START_KEYS.has(row.key)) continue;
      if (Object.hasOwn(KEY_ALIASES, row.key)) continue;
      if (WORKFLOW_LOCAL_KEYS.has(row.key)) continue;
      unknown.push(
        `${row.workflow} ${row.name} key "${row.key}" is not a chain_start param, a KEY_ALIASES alias, or a WORKFLOW_LOCAL_KEYS member — a typo here is silently ignored by chain_start`,
      );
    }
    expect(unknown).toEqual([]);
  });

  test("every chain_start param is exposed by a workflow or ledgered in NOT_EXPOSED", () => {
    const exposed = new Set<string>();
    for (const row of allowlistKeysFromSource()) {
      exposed.add(Object.hasOwn(KEY_ALIASES, row.key) ? KEY_ALIASES[row.key]! : row.key);
    }

    const problems: string[] = [];
    for (const key of CHAIN_START_KEYS) {
      if (!exposed.has(key) && !Object.hasOwn(NOT_EXPOSED, key)) {
        problems.push(
          `chain_start param '${key}' is neither exposed by any workflow nor in NOT_EXPOSED — expose it, or add it with a one-line reason and bump NOT_EXPOSED_EXPECTED_SIZE.`,
        );
      }
    }
    for (const key of Object.keys(NOT_EXPOSED)) {
      if (!CHAIN_START_KEYS.has(key)) {
        problems.push(
          `NOT_EXPOSED entry '${key}' is no longer a chain_start param — remove it and shrink NOT_EXPOSED_EXPECTED_SIZE.`,
        );
      } else if (exposed.has(key)) {
        problems.push(
          `NOT_EXPOSED entry '${key}' is now exposed by a workflow — remove it and shrink NOT_EXPOSED_EXPECTED_SIZE.`,
        );
      }
    }
    expect(problems).toEqual([]);
    expect(Object.keys(NOT_EXPOSED).length).toBe(NOT_EXPOSED_EXPECTED_SIZE);
  });
});
