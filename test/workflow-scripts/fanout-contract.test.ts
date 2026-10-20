import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ChainCancelInputShape } from "../../packages/mcp/src/tools/chain-cancel.js";
import { ChainGetMessagesInputShape } from "../../packages/mcp/src/tools/chain-get-messages.js";
import { ChainGetResponseInputShape } from "../../packages/mcp/src/tools/chain-get-response.js";
import { ChainStartInputShape } from "../../packages/mcp/src/tools/chain-start.js";
import { ChainStatusInputShape } from "../../packages/mcp/src/tools/chain-status.js";
import { ChainWaitInputShape } from "../../packages/mcp/src/tools/chain-wait.js";
import { DispatchAuditInputShape } from "../../packages/mcp/src/tools/dispatch-audit.js";
import { HandoffGetInputShape } from "../../packages/mcp/src/tools/handoff-get.js";
import { WorktreeInspectInputShape } from "../../packages/mcp/src/tools/worktree-inspect.js";
import { readRuntimeBody, runScript, runWorkflow, runWorkflowCapturingPrompts } from "./harness.js";

const FANOUT = ".claude/workflows/penumbra-fanout.js";
const FIX_UNTIL_GREEN = ".claude/workflows/penumbra-fix-until-green.js";

// The real input schemas behind every mcp__penumbra__ tool the dispatch
// prompts may instruct. chain_get_messages ships a ZodObject rather than a
// raw shape; both resolve to the accepted key set below.
const TOOL_INPUT_SHAPES: Record<string, unknown> = {
  chain_start: ChainStartInputShape,
  chain_wait: ChainWaitInputShape,
  chain_status: ChainStatusInputShape,
  chain_get_messages: ChainGetMessagesInputShape,
  handoff_get: HandoffGetInputShape,
  chain_get_response: ChainGetResponseInputShape,
  dispatch_audit: DispatchAuditInputShape,
  worktree_inspect: WorktreeInspectInputShape,
  chain_cancel: ChainCancelInputShape,
};

const PROMPT_COVERED_TOOLS = [
  "chain_start",
  "chain_wait",
  "chain_status",
  "chain_get_messages",
  "handoff_get",
  "chain_get_response",
  "dispatch_audit",
  "worktree_inspect",
  "chain_cancel",
];

function shapeKeys(shape: unknown): string[] {
  if (shape instanceof z.ZodObject) return Object.keys(shape.shape);
  if (shape !== null && typeof shape === "object" && !Array.isArray(shape)) {
    return Object.keys(shape);
  }
  return [];
}

// `mcp__penumbra__<tool>({ key, key: value, ... })` — keys are the shorthand
// identifiers plus the identifiers before ':'. Prompts are already rendered,
// so interpolations arrive as values, not source syntax.
function promptArgKeys(argText: string): string[] {
  const keys: string[] = [];
  for (const piece of argText.split(",")) {
    const named = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(piece);
    const bare = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(piece);
    const key = (named ?? bare)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

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
  logs: string[];
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
  const logs: string[] = [];
  const log = (message: unknown) => logs.push(String(message));
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
    return { result: result as FanoutReturn, calls, logs };
  } catch (error) {
    return { result: undefined, calls, logs, error };
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
  for (const [timeout, polls] of [
    [undefined, 30],
    [60000, 1],
    [99999999, 30],
  ] as const) {
    test(`poll budget ${String(timeout)} is computed before prompting`, async () => {
      const { calls, error } = await runFanout(
        {
          tasks: [{ message: "work", ...(timeout !== undefined ? { timeout_ms: timeout } : {}) }],
          repo: "/repo",
        },
        async () => null,
      );
      expect(error).toBeUndefined();
      const prompt = calls[0]?.prompt ?? "";
      expect(parseDispatchSpec(prompt).timeout_ms).toBe(timeout ?? 7200000);
      expect(prompt).toContain(`at most ${polls} iterations`);
      expect(prompt).not.toContain("ceil(spec.timeout_ms");
    });
  }

  test("polling exits early only on a terminal root status and cancels on timeout", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "work" }], repo: "/repo" },
      async () => null,
    );
    expect(error).toBeUndefined();
    const step = calls[0]?.prompt.split("\n").find((line) => line.startsWith("3. Poll")) ?? "";
    expect(step).toContain("after more than 8 slices");
    expect(step).toContain("mcp__penumbra__chain_status({ handoff_id: root_handoff_id })");
    expect(step).toContain("completed/failed/rejected/expired");
    expect(step).toContain("budget is exhausted");
    expect(step).toContain('status "timeout"');
    expect(step).toContain("Do not cancel a terminal chain");
    expect(step).toContain("cancellation failure");
    // The reliability block is advisory — it must never end polling early or
    // produce a "stalled" verdict; the daemon's own sweepers kill dead workers.
    expect(step).not.toContain('"stalled"');
    expect(step).not.toContain('not "wait"');
  });

  test("polling never makes reliability.recommended_action or non_terminal_stale a stop condition", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "work" }], repo: "/repo" },
      async () => null,
    );
    expect(error).toBeUndefined();
    const prompt = calls[0]?.prompt ?? "";
    const step = prompt.split("\n").find((line) => line.startsWith("3. Poll")) ?? "";
    expect(step).not.toBe("");
    expect(step).not.toContain("stalled");
    // Every sentence referencing the advisory reliability fields must be a
    // prohibition, not a trigger — a healthy lane can legitimately log no
    // dispatch_events for tens of minutes (worker heartbeats carry no
    // handoff_id, so they never counted as liveness evidence anyway).
    for (const sentence of step.split(/(?<=[.!]) /)) {
      if (!/recommended_action|non_terminal_stale|reliability\.status/.test(sentence)) continue;
      expect(sentence).toMatch(/NEVER|advisory|do not/i);
    }
    // chain_status is still consulted after eight slices — but only the
    // top-level handoff status may end the wait.
    expect(step).toContain("mcp__penumbra__chain_status({ handoff_id: root_handoff_id })");
    const schema = calls[0]?.options?.schema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(schema?.properties?.status?.description).not.toContain("stalled");
  });

  test("defaults every proxy to the dedicated fanout agent", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "a" }, { message: "b" }], repo: "/repo" },
      async () => null,
    );
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options?.agentType).toBe("penumbra:penumbra-fanout-proxy");
    }
  });

  test("inherit explicitly exposes Bash and omits the agent type", async () => {
    const { calls, logs, error } = await runFanout(
      { tasks: [{ message: "a" }], repo: "/repo", agentType: "inherit" },
      async () => null,
    );
    expect(error).toBeUndefined();
    expect(calls[0]?.options).not.toHaveProperty("agentType");
    expect(logs.some((line) => /WARNING.*Bash/.test(line))).toBe(true);
  });

  test("invalid agent types fail before any proxy starts", async () => {
    for (const agentType of [null, 42, {}, [], true, ""]) {
      const { calls, error } = await runFanout(
        { tasks: [{ message: "a" }], repo: "/repo", agentType },
        async () => null,
      );
      expect(String(error)).toContain("agentType must be a non-empty string");
      expect(calls).toHaveLength(0);
    }
  });

  for (const [message, code] of [
    ["agent type 'penumbra:penumbra-fanout-proxy' not found", "not_found"],
    ["permission denied", "denied"],
    ["transport failure", "other"],
    // Overload, MCP-down, and schema-validation wording must NOT classify as
    // not_found — that label points the operator at a session restart and is
    // reserved for agent-type resolution failures.
    ["ACP turn failed: engine overloaded (overloaded_error, 529)", "other"],
    ["mcp__penumbra__chain_start failed: MCP server unavailable", "other"],
    ["StructuredOutput schema validation failed: required property 'ok' not found", "other"],
  ]) {
    test(`proxy rejection is typed ${code} and preserves other slots`, async () => {
      let index = 0;
      const { result, error } = await runFanout(
        { tasks: [{ message: "a", label: "bad" }, { message: "b" }], repo: "/repo" },
        async () => {
          if (index++ === 0) throw new Error(message + "x".repeat(500));
          return {
            ok: true,
            status: "completed",
            conversation_id: "c",
            handoff_id: "h",
            reliability_trustworthy: true,
          };
        },
      );
      expect(error).toBeUndefined();
      expect(result?.results?.[0]).toMatchObject({
        ok: false,
        status: "proxy_error",
        error_code: code,
        label: "bad",
        index: 0,
      });
      expect(result?.results?.[0]?.error_summary).toStartWith("proxy_error:");
      expect(String(result?.results?.[0]?.error_summary).length).toBeLessThanOrEqual(313);
      expect(result?.results?.[1]?.ok).toBe(true);
      expect(result?.dropped).toHaveLength(0);
    });
  }

  test("successful-looking self-execution is classified no_dispatch before reliability", async () => {
    // no_dispatch means NO dispatch identity came back at all — neither a
    // conversation_id nor any handoff id. Anything with one real id escaped
    // the proxy's self-execution path and belongs to the reliability gate.
    for (const identity of [
      {},
      { conversation_id: " " },
      { handoff_id: "" },
      { conversation_id: " ", handoff_id: "" },
      { root_handoff_id: " " },
    ]) {
      const { result, error } = await runFanout(
        { tasks: [{ message: "a" }], repo: "/repo" },
        async () => ({ ok: true, status: "completed", reliability_trustworthy: true, ...identity }),
      );
      expect(error).toBeUndefined();
      expect(result?.results?.[0]).toMatchObject({
        ok: false,
        status: "no_dispatch",
        error_summary: "no_dispatch",
      });
    }
  });

  test("a single dispatch identity is enough to escape no_dispatch", async () => {
    // conversation_id is optional in the proxy's fill list — a dispatch that
    // returned only a handoff id (or only a conversation id) still proves it
    // reached the fleet and must not be reported as no_dispatch.
    for (const identity of [
      { conversation_id: "c" },
      { handoff_id: "h" },
      { root_handoff_id: "r" },
      { conversation_id: " ", handoff_id: "h" },
    ]) {
      const { result, error } = await runFanout(
        { tasks: [{ message: "a" }], repo: "/repo" },
        async () => ({ ok: true, status: "completed", reliability_trustworthy: true, ...identity }),
      );
      expect(error).toBeUndefined();
      expect(result?.results?.[0]?.status).not.toBe("no_dispatch");
      expect(result?.results?.[0]?.ok).toBe(true);
    }
  });

  test("no_dispatch preserves the underlying status and error cause", async () => {
    // Daemon rejections (prompt_project_mismatch, invalid project, worker
    // unavailable) and proxy refusals must survive the gate — erasing them
    // leaves fix-until-green stopping on a reason that names nothing.
    const { result, error } = await runFanout(
      { tasks: [{ message: "a" }], repo: "/repo" },
      async () => ({
        ok: false,
        status: "failed",
        error_summary: "chain_start rejected: prompt_project_mismatch",
      }),
    );
    expect(error).toBeUndefined();
    expect(result?.results?.[0]).toMatchObject({
      ok: false,
      status: "no_dispatch",
      proxy_status: "failed",
      error_summary: "no_dispatch: chain_start rejected: prompt_project_mismatch",
    });
  });

  test("no_dispatch without an upstream cause stays bare", async () => {
    const { result, error } = await runFanout(
      { tasks: [{ message: "a" }], repo: "/repo" },
      async () => ({ ok: false, status: "error" }),
    );
    expect(error).toBeUndefined();
    expect(result?.results?.[0]).toMatchObject({
      ok: false,
      status: "no_dispatch",
      proxy_status: "error",
      error_summary: "no_dispatch",
    });
  });

  test("step 6 asks for conversation_id without the schema requiring it", async () => {
    const { calls, error } = await runFanout(
      { tasks: [{ message: "m" }], repo: "/repo" },
      async () => null,
    );
    expect(error).toBeUndefined();
    const prompt = calls[0]?.prompt ?? "";
    const step = prompt.split("\n").find((line) => line.startsWith("6. Return")) ?? "";
    expect(step).toMatch(/conversation_id/);
    const schema = calls[0]?.options?.schema as { required?: string[] } | undefined;
    expect(schema?.required ?? []).not.toContain("conversation_id");
  });

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
        conversation_id: "c",
        handoff_id: "h",
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
        conversation_id: "c",
        handoff_id: "h",
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
      async () => ({
        ok: true,
        status: "completed",
        conversation_id: "c",
        handoff_id: "h",
        label: "noaudit",
        index: 0,
      }),
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
        conversation_id: "c",
        handoff_id: "h",
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
        return call === 1
          ? null
          : {
              ok: true,
              status: "completed",
              conversation_id: "c",
              handoff_id: "h",
              reliability_trustworthy: true,
            };
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

  test("every instructed mcp__penumbra__ call passes only real input-schema keys", async () => {
    // Fan-out prompt is identical across response modes bar the spec value;
    // run all three so a mode-specific call site cannot slip coverage.
    const fanout = await runScript(
      FANOUT,
      {
        tasks: [
          { message: "a", label: "f", response_mode: "full" },
          { message: "b", label: "fl", response_mode: "first_line" },
          { message: "c", label: "n", response_mode: "none" },
        ],
        repo: "/repo",
      },
      async () => null,
    );
    expect(fanout.error).toBeUndefined();

    // worktree_inspect is only instructed by fix-until-green's rubric-grader
    // prompt, which is built deep inside a passing+verified round — drive the
    // script far enough to capture it.
    const fix = await runScript(
      FIX_UNTIL_GREEN,
      {
        task: { message: "m" },
        check: "true",
        rubric: ["criterion one"],
        maxRounds: 1,
        defaults: { caller_cwd: "/abs" },
      },
      async (_prompt, options) => {
        const label = String(options?.label ?? "");
        if (label.startsWith("rubric")) return { overall_pass: true, criteria: [] };
        return { ran: true, check_exit: 0 };
      },
      async () => ({
        results: [
          {
            ok: true,
            status: "completed",
            branch: "feat/x",
            conversation_id: "c",
            handoff_id: "h-1",
            reliability_trustworthy: true,
            check_line: "CHECK_RESULT: PASS",
          },
        ],
      }),
    );
    expect(fix.error).toBeUndefined();

    const instructed = new Map<string, Set<string>>();
    const unknownTools = new Set<string>();
    for (const prompt of [...fanout.prompts, ...fix.prompts]) {
      for (const match of prompt.matchAll(/mcp__penumbra__([a-z_]+)\s*\(\s*\{([^}]*)\}/g)) {
        const tool = match[1]!;
        if (!(tool in TOOL_INPUT_SHAPES)) {
          unknownTools.add(tool);
          continue;
        }
        const keys = instructed.get(tool) ?? new Set<string>();
        for (const key of promptArgKeys(match[2] ?? "")) keys.add(key);
        instructed.set(tool, keys);
      }
    }
    const failures: string[] = [...unknownTools].map(
      (tool) => `prompt instructs unknown tool mcp__penumbra__${tool}`,
    );
    for (const tool of PROMPT_COVERED_TOOLS) {
      if (!instructed.has(tool)) {
        failures.push(`no prompt instructs ${tool}({ ... }) — contract coverage gap`);
      }
    }
    for (const [tool, keys] of instructed) {
      const allowed = new Set(shapeKeys(TOOL_INPUT_SHAPES[tool]));
      for (const key of keys) {
        if (!allowed.has(key)) {
          failures.push(`${tool} arg "${key}" is not in the real input schema`);
        }
      }
    }
    expect(failures.sort()).toEqual([]);
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
