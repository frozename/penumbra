import { describe, expect, test } from "bun:test";

import { readRuntimeBody, runWorkflow, runWorkflowCapturingPrompts } from "./harness.js";

const FLEET_VERIFY = ".claude/workflows/penumbra-fleet-verify.js";
const TOKEN_OPT_BATCH = ".claude/workflows/penumbra-token-opt-batch.js";
const TOKEN_OPT_MIGRATE = ".claude/workflows/penumbra-token-opt-migrate.js";

const ABS_REPO = "/abs/repo";

interface ScriptReturn {
  ok?: boolean;
  tasks?: number;
  failed?: unknown;
  dropped?: unknown;
  skipped?: unknown;
  landable?: Array<Record<string, unknown>>;
  landed?: unknown[];
  passed_verify?: string[];
  failed_verify?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;

// runWorkflowCapturingPrompts fixes its agent stub and drops the return value;
// landing-path assertions need a caller-controlled stub, the schema passed via
// options, and the workflow's own return value. Same new-Function discipline
// as harness.ts.
async function runScript(
  path: string,
  args: unknown,
  agentStub: AgentStub,
): Promise<{
  result: ScriptReturn | undefined;
  calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
  error?: unknown;
}> {
  const body = readRuntimeBody(path);
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    calls.push({ prompt: String(prompt), options });
    return await agentStub(prompt, options);
  };
  const parallel = async (items: unknown[]) =>
    await Promise.all(
      items.map((item) => (typeof item === "function" ? (item as () => unknown)() : item)),
    );
  const pipeline = async (items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>) =>
    stages.reduce<Promise<unknown[]>>(
      async (acc, stage) => await Promise.all((await acc).map((item, i) => stage(item, items[i]))),
      Promise.resolve(items),
    );
  const phase = async (_name: string, fn?: () => unknown) => await (fn ? fn() : undefined);
  const log = () => {};
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
  ) as (...fnArgs: unknown[]) => Promise<unknown>;

  try {
    const result = await run(agent, parallel, pipeline, phase, log, args, {}, async () => ({}));
    return { result: result as ScriptReturn, calls };
  } catch (error) {
    return { result: undefined, calls, error };
  }
}

const RELIABILITY_FIELDS = [
  "reliability_status",
  "reliability_trustworthy",
  "reliability_action",
] as const;

describe("dispatch_audit reliability coverage", () => {
  const cases = [
    {
      name: "penumbra-fleet-verify",
      path: FLEET_VERIFY,
      args: { tasks: [{ name: "n", dispatchPrompt: "p" }], repo: ABS_REPO },
    },
    {
      name: "penumbra-token-opt-batch",
      path: TOKEN_OPT_BATCH,
      args: { migrations: [{ tool: "t", dispatchPrompt: "p" }], repo: ABS_REPO },
    },
    {
      name: "penumbra-token-opt-migrate",
      path: TOKEN_OPT_MIGRATE,
      args: { tool: "t", dispatchPrompt: "p", repo: ABS_REPO },
    },
  ];

  for (const { name, path, args } of cases) {
    test(`${name} requests dispatch_audit and requires the reliability fields`, async () => {
      const { calls, error } = await runScript(path, args, async () => ({
        branch: "MISSING",
        commit_count: 0,
      }));

      expect(error).toBeUndefined();
      const dispatchCall = calls.find((call) =>
        String(call.options?.label ?? "").startsWith("dispatch:"),
      );
      expect(dispatchCall).toBeDefined();
      expect(dispatchCall!.prompt).toContain("mcp__penumbra__dispatch_audit");
      const schema = dispatchCall!.options?.schema as
        | { required?: string[]; properties?: Record<string, { type?: string }> }
        | undefined;
      for (const field of RELIABILITY_FIELDS) {
        expect(
          schema?.required,
          `${name}: ${field} must be required or the proxy may omit it`,
        ).toContain(field);
        expect(schema?.properties).toHaveProperty(field);
      }
      expect(schema?.properties?.reliability_trustworthy?.type).toBe("boolean");
    });
  }
});

describe("penumbra-fleet-verify", () => {
  test("emits a per-task task_type with implement_small as the default", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(FLEET_VERIFY, {
      tasks: [
        { name: "custom", dispatchPrompt: "p", task_type: "implement_large" },
        { name: "plain", dispatchPrompt: "p" },
      ],
      repo: ABS_REPO,
    });

    expect(error).toBeUndefined();
    expect(prompts[0] ?? "").toContain('task_type="implement_large"');
    expect(prompts[1] ?? "").toContain('task_type="implement_small"');
  });

  test("rejects a relative args.repo before any dispatch", async () => {
    const result = await runWorkflow(FLEET_VERIFY, {
      tasks: [{ name: "n", dispatchPrompt: "p" }],
      repo: "relative/path",
    });

    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/args\.repo must be a non-empty ABSOLUTE path/);
    expect(result.agentCalls).toBe(0);
  });

  test("accepts defaults and threads them into the dispatch prompt", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(FLEET_VERIFY, {
      tasks: [{ name: "n", dispatchPrompt: "p" }],
      repo: ABS_REPO,
      defaults: {
        trust_mode: "config",
        use_worktree: false,
        max_hops: 3,
        project_id: "penumbra",
      },
    });

    expect(error).toBeUndefined();
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain('trust_mode="config"');
    expect(prompt).toContain("use_worktree=false");
    expect(prompt).toContain("max_hops=3");
    expect(prompt).toContain('project_id="penumbra"');
  });

  test("a task_name containing a double quote stays one balanced token", async () => {
    const taskName = 'fix "the" parser';
    const { prompts, error } = await runWorkflowCapturingPrompts(FLEET_VERIFY, {
      tasks: [{ name: "n", dispatchPrompt: "p", task_name: taskName }],
      repo: ABS_REPO,
    });

    expect(error).toBeUndefined();
    const match = /task_name=("(?:[^"\\]|\\.)*")/.exec(prompts[0] ?? "");
    expect(match, "prompt should carry task_name as one balanced quoted token").not.toBeNull();
    expect(JSON.parse(match![1]!)).toBe(taskName);
  });

  test("returns ok/failed/dropped/skipped tallies computed from the results", async () => {
    const stub: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label === "dispatch:good" || label === "dispatch:failing") {
        return {
          name: label.slice("dispatch:".length),
          handoff_id: `h-${label}`,
          status: "completed",
          branch: `b-${label}`,
          branch_tip: "abc1234",
          commit_count: 1,
          reliability_trustworthy: true,
        };
      }
      if (label === "dispatch:nobranch") {
        return {
          name: "nobranch",
          handoff_id: "h-skip",
          status: "failed",
          branch: "MISSING",
          commit_count: 0,
          reliability_trustworthy: true,
        };
      }
      if (label === "verify:good") return { name: "good", verdict: "pass" };
      if (label === "verify:failing") return { name: "failing", verdict: "fail" };
      return {};
    };

    const { result, error } = await runScript(
      FLEET_VERIFY,
      {
        tasks: [
          { name: "good", dispatchPrompt: "p" },
          { name: "failing", dispatchPrompt: "p" },
          { name: "nobranch", dispatchPrompt: "p" },
        ],
        repo: ABS_REPO,
      },
      stub,
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      ranNothingToMain: true,
      ok: false,
      tasks: 3,
      failed: ["failing"],
      dropped: [],
      skipped: ["nobranch"],
    });
    expect(result?.landable).toHaveLength(1);
    expect(result?.landable?.[0]).toMatchObject({ name: "good", handoff_id: "h-dispatch:good" });
  });

  test("reports ok:true when every task verifies clean", async () => {
    const stub: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("dispatch:")) {
        return {
          name: "good",
          handoff_id: "h-good",
          status: "completed",
          branch: "b-good",
          branch_tip: "abc1234",
          commit_count: 1,
          reliability_trustworthy: true,
        };
      }
      return { name: "good", verdict: "pass" };
    };

    const { result, error } = await runScript(
      FLEET_VERIFY,
      { tasks: [{ name: "good", dispatchPrompt: "p" }], repo: ABS_REPO },
      stub,
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, failed: [], dropped: [], skipped: [] });
  });
});

describe("penumbra-token-opt-batch", () => {
  test("rejects a missing or relative args.repo before any dispatch", async () => {
    const argSets: unknown[] = [
      { migrations: [{ tool: "t", dispatchPrompt: "p" }] },
      { migrations: [{ tool: "t", dispatchPrompt: "p" }], repo: "relative/path" },
      { migrations: [{ tool: "t", dispatchPrompt: "p" }], repo: "." },
      { migrations: [{ tool: "t", dispatchPrompt: "p" }], repo: "" },
    ];

    for (const args of argSets) {
      const result = await runWorkflow(TOKEN_OPT_BATCH, args);
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/args\.repo must be a non-empty ABSOLUTE path/);
      expect(result.agentCalls).toBe(0);
    }
  });

  test("an untrustworthy dispatch is excluded from the land loop even when verify passes", async () => {
    const stub: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("dispatch:")) {
        return {
          handoff_id: "h-untrusted",
          status: "completed",
          branch: "b-untrusted",
          branch_tip: "abc1234",
          commit_count: 1,
          reliability_status: "non_terminal_stale",
          reliability_trustworthy: false,
          reliability_action: "inspect_worktree",
        };
      }
      if (label.startsWith("verify:")) return { verdict: "pass" };
      return { landed: true, commit_sha: "abc1234", head_after: "abc1234" };
    };

    const { result, calls, error } = await runScript(
      TOKEN_OPT_BATCH,
      { migrations: [{ tool: "m1", dispatchPrompt: "p" }], repo: ABS_REPO },
      stub,
    );

    expect(error).toBeUndefined();
    const landCalls = calls.filter((call) => String(call.options?.label ?? "").startsWith("land:"));
    expect(landCalls).toHaveLength(0);
    expect(calls.map((call) => call.prompt).join("\n")).not.toContain("dispatch_land");
    expect(result?.landed).toHaveLength(0);
    expect(result?.passed_verify).toEqual([]);
    expect(result?.failed_verify?.[0]).toMatchObject({
      tool: "m1",
      verdict: "pass",
      reliability_trustworthy: false,
    });
    expect(result?.ok).toBe(false);
  });

  test("a trustworthy verified migration still reaches the land loop", async () => {
    const stub: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("dispatch:")) {
        return {
          handoff_id: "h-ok",
          status: "completed",
          branch: "b-ok",
          branch_tip: "abc1234",
          commit_count: 1,
          reliability_status: "complete",
          reliability_trustworthy: true,
          reliability_action: "accept",
        };
      }
      if (label.startsWith("verify:")) return { verdict: "pass" };
      return {
        tool: "m1",
        handoff_id: "h-ok",
        landed: true,
        commit_sha: "abc1234",
        head_after: "abc1234",
        content_in_main: true,
        cleaned_up: true,
        pushed: false,
      };
    };

    const { result, calls, error } = await runScript(
      TOKEN_OPT_BATCH,
      { migrations: [{ tool: "m1", dispatchPrompt: "p" }], repo: ABS_REPO },
      stub,
    );

    expect(error).toBeUndefined();
    const landCalls = calls.filter((call) => String(call.options?.label ?? "").startsWith("land:"));
    expect(landCalls).toHaveLength(1);
    expect(result?.ok).toBe(true);
  });
});

describe("penumbra-token-opt-migrate", () => {
  test("rejects a missing or relative args.repo before any dispatch", async () => {
    const argSets: unknown[] = [
      { tool: "t", dispatchPrompt: "p" },
      { tool: "t", dispatchPrompt: "p", repo: "relative/path" },
      { tool: "t", dispatchPrompt: "p", repo: "." },
    ];

    for (const args of argSets) {
      const result = await runWorkflow(TOKEN_OPT_MIGRATE, args);
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/args\.repo must be a non-empty ABSOLUTE path/);
      expect(result.agentCalls).toBe(0);
    }
  });
});
