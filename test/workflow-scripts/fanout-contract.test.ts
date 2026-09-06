import { describe, expect, test } from "bun:test";

import { ChainStartInputShape } from "../../packages/mcp/src/tools/chain-start.js";
import { readRuntimeBody, runWorkflow, runWorkflowCapturingPrompts } from "./harness.js";

const FANOUT = ".claude/workflows/penumbra-fanout.js";

interface DispatchResultRecord {
  ok?: boolean;
  label?: string;
  index?: number;
  error_summary?: string;
  reliability_trustworthy?: boolean;
  [key: string]: unknown;
}

interface FanoutReturn {
  ok?: boolean;
  completed?: number;
  failed?: number;
  dropped?: DispatchResultRecord[];
  results?: DispatchResultRecord[];
  [key: string]: unknown;
}

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;

// runWorkflowCapturingPrompts fixes its agent stub and drops the return value;
// result-shape assertions need both. Same new-Function discipline as harness.ts.
async function runFanout(
  args: unknown,
  agentStub: AgentStub,
): Promise<{
  result: FanoutReturn | undefined;
  calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
  error?: unknown;
}> {
  const body = readRuntimeBody(FANOUT);
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    calls.push({ prompt: String(prompt), options });
    return await agentStub(prompt, options);
  };
  const parallel = async (items: unknown[]) =>
    await Promise.all(
      items.map((item) => (typeof item === "function" ? (item as () => unknown)() : item)),
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
    const result = await run(
      agent,
      parallel,
      async (items: unknown[]) => await Promise.all(items),
      phase,
      log,
      args,
      {},
      async () => ({}),
    );
    return { result: result as FanoutReturn, calls };
  } catch (error) {
    return { result: undefined, calls, error };
  }
}

function parseDispatchSpec(prompt: string): Record<string, unknown> {
  const m = /```dispatch\n([\s\S]*?)\n```/.exec(prompt);
  if (!m || m[1] === undefined) throw new Error("no ```dispatch fence in prompt");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

function step2Line(prompt: string): string {
  return (
    prompt.split("\n").find((line) => line.startsWith("2. Call mcp__penumbra__chain_start")) ?? ""
  );
}

// Dispatch-spec keys the step-2 chain_start sentence legitimately does NOT
// name — each ledgered with the reason its prose absence is correct rather
// than a doc gap. Both are absent from the real chain_start schema, asserted
// below via ChainStartInputShape so a schema drift cannot silently excuse a
// missing key.
const PROSE_OMITTED: Record<string, string> = {
  timeout_ms: "step-3 poll budget, not a chain_start param",
  response_mode: "step-4 branch selector, not a chain_start param",
};
const PROSE_OMITTED_EXPECTED_SIZE = 2;

const EVERY_TASK_KEY: Record<string, unknown> = {
  label: "census-label",
  name: "census-name",
  title: "census-title",
  task_name: "census-task",
  branch_type: "feat",
  initial_agent: "executor",
  task_class: "STANDARD",
  task_type: "implement_small",
  trust_mode: "config",
  use_worktree: false,
  max_hops: 3,
  timeout_ms: 60000,
  message: "do the work",
  branch_base: "main",
  response_mode: "full",
  project_id: "penumbra",
  caller_cwd: "/abs/repo",
  isolated_install: false,
};

describe("penumbra-fanout dispatch contract", () => {
  test("PROSE_OMITTED ledger stays honest against the chain_start schema", () => {
    expect(Object.keys(PROSE_OMITTED)).toHaveLength(PROSE_OMITTED_EXPECTED_SIZE);
    for (const key of Object.keys(PROSE_OMITTED)) {
      expect(
        Object.hasOwn(ChainStartInputShape, key),
        `PROSE_OMITTED.${key} (${PROSE_OMITTED[key]}) is now a chain_start param — it must be named in the step-2 sentence`,
      ).toBe(false);
    }
  });

  test("every dispatch-spec key is named in the step-2 chain_start sentence", async () => {
    // Two tasks cover both project-scope paths: project_id suppresses
    // caller_cwd in the spec, so caller_cwd prose coverage needs its own run.
    const cwdTask = { ...EVERY_TASK_KEY };
    delete cwdTask.project_id;
    const { prompts, error } = await runWorkflowCapturingPrompts(FANOUT, {
      tasks: [EVERY_TASK_KEY, cwdTask],
    });

    expect(error).toBeUndefined();
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const spec = parseDispatchSpec(prompt);
      const line = step2Line(prompt);
      expect(line).not.toBe("");
      for (const key of Object.keys(spec)) {
        if (Object.hasOwn(PROSE_OMITTED, key)) continue;
        expect(
          new RegExp(`\\b${key}\\b`).test(line),
          `dispatch-spec key "${key}" is not named in the step-2 chain_start sentence — the proxy has no instruction to pass it`,
        ).toBe(true);
      }
    }
  });

  test("task-level isolated_install:false and use_worktree:false survive truthy defaults", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(FANOUT, {
      tasks: [{ message: "m", isolated_install: false, use_worktree: false }],
      defaults: { project_id: "penumbra", isolated_install: true, use_worktree: true },
    });

    expect(error).toBeUndefined();
    const spec = parseDispatchSpec(prompts[0] ?? "");
    expect(spec.isolated_install).toBe(false);
    expect(spec.use_worktree).toBe(false);
  });

  test("the step-2 falsy clause names use_worktree as well as isolated_install", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(FANOUT, {
      tasks: [{ message: "m" }],
      defaults: { project_id: "penumbra" },
    });

    expect(error).toBeUndefined();
    const line = step2Line(prompts[0] ?? "");
    const start = line.indexOf("Pass isolated_install");
    const end = line.indexOf("falsy");
    const clause = start >= 0 && end > start ? line.slice(start, end) : "";
    expect(clause).toContain("isolated_install");
    expect(clause).toContain("use_worktree");
  });

  test("DISPATCH_RESULT declares reliability + identity fields and the protocol calls dispatch_audit", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "m", label: "audit" }], defaults: { project_id: "penumbra" } },
      async () => ({ ok: true, status: "completed" }),
    );

    expect(error).toBeUndefined();
    const schema = calls[0]?.options?.schema as
      | { required?: string[]; properties?: Record<string, { type?: string }> }
      | undefined;
    expect(schema?.required).toEqual(expect.arrayContaining(["label", "index"]));
    expect(schema?.properties?.reliability_status?.type).toBe("string");
    expect(schema?.properties?.reliability_trustworthy?.type).toBe("boolean");
    expect(schema?.properties?.reliability_action?.type).toBe("string");
    expect(calls[0]?.prompt).toContain("mcp__penumbra__dispatch_audit");
    expect(calls[0]?.prompt).toContain('label "audit"');
    expect(calls[0]?.prompt).toContain("index 0");
  });

  test("the dispatch_audit step names the nested report.* paths", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(FANOUT, {
      tasks: [{ message: "m" }],
      defaults: { project_id: "penumbra" },
    });

    expect(error).toBeUndefined();
    const prompt = prompts[0] ?? "";
    const auditStep =
      prompt.split("\n").find((line) => line.includes("mcp__penumbra__dispatch_audit")) ?? "";
    expect(auditStep).not.toBe("");
    // The tool nests its payload under `report` — bare top-level field names
    // copy nothing, which is exactly how the fail-open gate shipped inert.
    expect(auditStep).toContain("under a `report` key");
    expect(auditStep).toMatch(/\breport\.status\b/);
    expect(auditStep).toMatch(/\breport\.trustworthy\b/);
    expect(auditStep).toMatch(/\breport\.recommended_action\b/);
  });

  test("the fail-closed rule is stated in step 6 and the ok schema description", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "m" }], defaults: { project_id: "penumbra" } },
      async () => ({ ok: false, status: "failed" }),
    );

    expect(error).toBeUndefined();
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("reliability_trustworthy === true");
    expect(prompt).toContain("a missing audit is NOT trustworthy");
    const schema = calls[0]?.options?.schema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(schema?.properties?.ok?.description).toContain("reliability_trustworthy === true");
    expect(schema?.properties?.ok?.description).toContain("NOT trustworthy");
  });

  test("aggregate ok is false when a completed dispatch is reliability-untrustworthy", async () => {
    const { result, error } = await runFanout(
      { tasks: [{ message: "m", label: "t0" }], defaults: { project_id: "penumbra" } },
      // dispatch_audit returns its payload nested under `report`; the proxy
      // copies report.* into the flat reliability_* fields per the protocol.
      async () => ({
        ok: true,
        status: "completed",
        report: { status: "complete", trustworthy: false, recommended_action: "inspect_worktree" },
        reliability_status: "complete",
        reliability_trustworthy: false,
        reliability_action: "inspect_worktree",
      }),
    );

    expect(error).toBeUndefined();
    expect(result?.results?.[0]?.ok).toBe(false);
    expect(result?.results?.[0]?.error_summary).toBe("reliability_untrustworthy");
    expect(result?.ok).toBe(false);
    expect(result?.completed).toBe(0);
    expect(result?.failed).toBe(1);
  });

  test("aggregate ok stays true when a completed dispatch is trustworthy", async () => {
    const { result, error } = await runFanout(
      { tasks: [{ message: "m", label: "t0" }], defaults: { project_id: "penumbra" } },
      async () => ({
        ok: true,
        status: "completed",
        report: { status: "complete", trustworthy: true, recommended_action: "accept" },
        reliability_status: "complete",
        reliability_trustworthy: true,
        reliability_action: "accept",
      }),
    );

    expect(error).toBeUndefined();
    expect(result?.results?.[0]?.ok).toBe(true);
    expect(result?.ok).toBe(true);
    expect(result?.completed).toBe(1);
    expect(result?.failed).toBe(0);
  });

  test("a completed-looking result with ABSENT reliability fields fails closed", async () => {
    const { result, error } = await runFanout(
      { tasks: [{ message: "m", label: "noaudit" }], defaults: { project_id: "penumbra" } },
      // The proxy copied nothing — the reliability_* fields are absent
      // entirely. Fail-open reads this as covered; the gate must read it as failed.
      async () => ({ ok: true, status: "completed", label: "noaudit", index: 0 }),
    );

    expect(error).toBeUndefined();
    expect(result?.results?.[0]?.ok).toBe(false);
    expect(result?.results?.[0]?.error_summary).toBe("reliability_unverified");
    expect(result?.completed).toBe(0);
    expect(result?.failed).toBe(1);
    expect(result?.ok).toBe(false);
  });

  test("a proxy returning only the nested dispatch_audit report fails closed", async () => {
    // The real tool returns { report: {...} }; a proxy that surfaced the
    // nested payload without copying report.* into the flat reliability_*
    // fields must NOT leak through the gate.
    const { result, error } = await runFanout(
      { tasks: [{ message: "m", label: "nested" }], defaults: { project_id: "penumbra" } },
      async () => ({
        ok: true,
        status: "completed",
        label: "nested",
        index: 0,
        report: { status: "complete", trustworthy: true, recommended_action: "accept" },
      }),
    );

    expect(error).toBeUndefined();
    expect(result?.results?.[0]?.ok).toBe(false);
    expect(result?.results?.[0]?.error_summary).toBe("reliability_unverified");
    expect(result?.completed).toBe(0);
    expect(result?.failed).toBe(1);
    expect(result?.ok).toBe(false);
  });

  test("a malformed JSON string for args throws a parse error, not a missing-tasks error", async () => {
    const result = await runWorkflow(FANOUT, "{not valid json");

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("penumbra-fanout: args was a string but not valid JSON");
    expect(result.agentCalls).toBe(0);
  });

  test("a dropped proxy result is substituted in place, naming the task label and index", async () => {
    let call = 0;
    const { result, error } = await runFanout(
      {
        tasks: [
          { label: "alpha", message: "m0" },
          { label: "beta", message: "m1" },
        ],
        defaults: { project_id: "penumbra" },
      },
      async () => {
        call += 1;
        return call === 1 ? null : { ok: true, status: "completed", reliability_trustworthy: true };
      },
    );

    expect(error).toBeUndefined();
    const results = result?.results ?? [];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      ok: false,
      label: "alpha",
      index: 0,
      error_summary: "agent_dropped",
    });
    expect(results[1]).toMatchObject({ ok: true, label: "beta", index: 1 });
    expect(result?.ok).toBe(false);
    expect(result?.dropped).toHaveLength(1);
    expect(result?.dropped?.[0]).toMatchObject({ label: "alpha", index: 0 });
  });

  test("non-positive max_hops/timeout_ms are rejected loudly before any dispatch", async () => {
    const cases: unknown[] = [
      { tasks: [{ message: "m", max_hops: 0 }], defaults: { project_id: "penumbra" } },
      { tasks: [{ message: "m", timeout_ms: 0 }], defaults: { project_id: "penumbra" } },
      { tasks: [{ message: "m" }], defaults: { project_id: "penumbra", max_hops: 0 } },
      { tasks: [{ message: "m" }], defaults: { project_id: "penumbra", timeout_ms: -1 } },
    ];

    for (const args of cases) {
      const result = await runWorkflow(FANOUT, args);
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/must be a positive integer/);
      expect(result.agentCalls).toBe(0);
    }
  });
});
