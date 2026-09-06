import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readRuntimeBody, runWorkflowCapturingPrompts } from "./harness.js";

const SWEEP = ".claude/workflows/penumbra-review-sweep.js";
const ADVERSARIAL = ".claude/workflows/adversarial-review.js";
const FANOUT = ".claude/workflows/penumbra-fanout.js";

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;

interface ReviewResultRecord {
  ok?: boolean;
  target_ref?: string;
  index?: number;
  error_summary?: string;
  [key: string]: unknown;
}

interface SweepReturn {
  ok?: boolean;
  total?: number;
  reviewed_ok?: number;
  dropped?: ReviewResultRecord[];
  results?: ReviewResultRecord[];
  [key: string]: unknown;
}

// The shared harness drops the workflow's return value; these tests assert on
// the returned object, so run the body with the same stub surface locally.
async function runReturning(
  path: string,
  args: unknown,
  agentStub?: AgentStub,
): Promise<{
  result: unknown;
  prompts: string[];
  schemas: unknown[];
  error?: unknown;
}> {
  const body = readRuntimeBody(path);
  const prompts: string[] = [];
  const schemas: unknown[] = [];
  const stub: AgentStub = agentStub ?? (async () => ({}));
  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    prompts.push(String(prompt));
    schemas.push(options?.schema);
    return stub(prompt, options);
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
  ) as (...fns: unknown[]) => Promise<unknown>;

  try {
    const result = await run(agent, parallel, pipeline, phase, log, args, budget, workflow);
    return { result, prompts, schemas };
  } catch (error) {
    return { result: undefined, prompts, schemas, error };
  }
}

function parseJsonFence(prompt: string): Record<string, unknown> {
  const match = prompt.match(/```json\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) throw new Error("no ```json fence in prompt");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function validatorBlock(path: string): string {
  const match = readFileSync(resolve(path), "utf8").match(
    /\/\/ task-spec-validation:begin\n([\s\S]*?)\/\/ task-spec-validation:end/,
  );
  if (!match || match[1] === undefined) {
    throw new Error(`${path}: missing task-spec validator block`);
  }
  return match[1];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) throw new Error("agent call carried no schema.properties");
  return properties;
}

describe("penumbra-review-sweep repo scope", () => {
  test("workflow_run payload carries the absolute repo as cwd", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "abc" }],
    });

    expect(error).toBeUndefined();
    const payload = parseJsonFence(prompts[0] ?? "");
    expect(payload.name).toBe("adversarial-review");
    expect(payload.cwd).toBe("/tmp/x");
    expect(payload.wait).toBe(false);
  });

  test("returns no_repo_scope and spends nothing when repo is missing", async () => {
    const { result, prompts, error } = await runReturning(SWEEP, {
      targets: [{ target_ref: "abc" }],
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: false, error: "no_repo_scope" });
    expect(prompts).toHaveLength(0);
  });

  test("returns no_repo_scope and spends nothing when repo is relative", async () => {
    const { result, prompts, error } = await runReturning(SWEEP, {
      repo: "relative/path",
      targets: [{ target_ref: "abc" }],
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: false, error: "no_repo_scope" });
    expect(prompts).toHaveLength(0);
  });

  test("rejects an unknown per-target key before any agent call", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a", targt_ref: "typo" }],
    });

    expect(error).toBeDefined();
    expect(String(error)).toMatch(/penumbra-review-sweep: unknown key "targt_ref" at targets\[0\]/);
    expect(prompts).toHaveLength(0);
  });

  test("rejects a relative per-target repo before any agent call", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a", repo: "relative/path" }],
    });

    expect(error).toBeDefined();
    expect(String(error)).toMatch(/repo must be an ABSOLUTE path/);
    expect(prompts).toHaveLength(0);
  });

  test("a per-target repo overrides the top-level repo as cwd", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a", repo: "/tmp/y" }],
    });

    expect(error).toBeUndefined();
    expect(parseJsonFence(prompts[0] ?? "").cwd).toBe("/tmp/y");
  });

  test("poll instruction passes the same cwd to workflow_wait", async () => {
    const { prompts, error } = await runWorkflowCapturingPrompts(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a" }],
    });

    expect(error).toBeUndefined();
    const waitLines = (prompts[0] ?? "")
      .split("\n")
      .filter((line) => /(call|loop)\s+mcp__penumbra__workflow_wait/.test(line));
    expect(waitLines.length).toBeGreaterThan(0);
    for (const line of waitLines) {
      expect(line).toContain("cwd");
      expect(line).toContain('"/tmp/x"');
    }
  });

  test("prompt carries the resolution_warning tripwire and schema exposes it", async () => {
    const { prompts, schemas, error } = await runReturning(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a" }],
    });

    expect(error).toBeUndefined();
    expect(prompts[0] ?? "").toContain("resolution_warning");
    expect(prompts[0] ?? "").toContain("workflow_cwd_inferred_from_mcp_cwd");
    const properties = schemaProperties(schemas[0]);
    expect(properties.resolution_warning).toBeDefined();
    expect(properties.review_cwd).toBeDefined();
  });

  test("validator block is byte-identical to penumbra-fanout's", () => {
    expect(validatorBlock(SWEEP)).toBe(validatorBlock(FANOUT));
  });
});

describe("penumbra-review-sweep dropped results", () => {
  test("a dropped proxy result is substituted in place, keeping index order stable", async () => {
    let call = 0;
    const { result, error } = await runReturning(
      SWEEP,
      {
        repo: "/tmp/x",
        targets: [{ target_ref: "first" }, { target_ref: "mid" }, { target_ref: "third" }],
      },
      async () => {
        call += 1;
        return call === 2 ? null : { ok: true, outcome: "success" };
      },
    );

    expect(error).toBeUndefined();
    const sweep = result as SweepReturn | undefined;
    const results = sweep?.results ?? [];
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results[0]).toMatchObject({ ok: true, target_ref: "first", index: 0 });
    expect(results[1]).toMatchObject({
      ok: false,
      target_ref: "mid",
      index: 1,
      error_summary: "agent_dropped",
    });
    expect(results[2]).toMatchObject({ ok: true, target_ref: "third", index: 2 });
    expect(sweep?.ok).toBe(false);
    expect(sweep?.total).toBe(3);
    expect(sweep?.reviewed_ok).toBe(2);
    expect(sweep?.dropped).toHaveLength(1);
    expect(sweep?.dropped?.[0]).toMatchObject({ target_ref: "mid", index: 1 });
  });

  test("a target without target_ref gets the stable target-i identity in its dropped record", async () => {
    const { result, error } = await runReturning(
      SWEEP,
      { repo: "/tmp/x", targets: [{}] },
      async () => null,
    );

    expect(error).toBeUndefined();
    const sweep = result as SweepReturn | undefined;
    expect(sweep?.results?.[0]).toMatchObject({
      ok: false,
      target_ref: "target-0",
      index: 0,
      error_summary: "agent_dropped",
    });
  });

  test("REVIEW_RESULT requires target_ref and index, and the prompt instructs a verbatim echo", async () => {
    const { prompts, schemas, error } = await runReturning(SWEEP, {
      repo: "/tmp/x",
      targets: [{ target_ref: "a" }, {}],
    });

    expect(error).toBeUndefined();
    const schema = schemas[0] as
      | { required?: string[]; properties?: Record<string, { type?: string }> }
      | undefined;
    expect(schema?.required).toEqual(expect.arrayContaining(["target_ref", "index"]));
    expect(schema?.properties?.index?.type).toBe("integer");
    expect(prompts[0] ?? "").toContain('target_ref "a"');
    expect(prompts[0] ?? "").toContain("index 0");
    expect(prompts[1] ?? "").toContain('target_ref "target-1"');
    expect(prompts[1] ?? "").toContain("index 1");
  });
});

describe("adversarial-review repo scope", () => {
  const CLEAN_SYNTHESIS = {
    outcome: "success",
    verdict: "land",
    high: [],
    medium: [],
    low: [],
    completed_personas: ["persona-a"],
    failed_personas: [],
  };

  test("returns a blocking verdict and spends nothing when repo is missing", async () => {
    const { result, prompts, error } = await runReturning(ADVERSARIAL, { target_ref: "abc" });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      verdict: "block",
      outcome: "failed",
      high_count: 0,
      completed_personas: [],
      failed_personas: ["no_repo_scope"],
    });
    expect(prompts).toHaveLength(0);
  });

  test("returns a blocking verdict and spends nothing when repo is relative", async () => {
    const { result, prompts, error } = await runReturning(ADVERSARIAL, {
      target_ref: "abc",
      repo: "relative/path",
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      verdict: "block",
      failed_personas: ["no_repo_scope"],
    });
    expect(prompts).toHaveLength(0);
  });

  test("forwards repo as workflow_run cwd, workflow_wait cwd, and chain_start caller_cwd", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("review:")) {
        return {
          ...CLEAN_SYNTHESIS,
          high: [{ id: "F1", severity: "high", title: "a high finding" }],
        };
      }
      if (label === "fix:round1") {
        return {
          handoff_id: "h1",
          branch: "fix-branch",
          commit_count: 1,
          status: "completed",
        };
      }
      if (label === "grade:round1") {
        return {
          findings: [{ finding_id: "F1", addressed: true, regression_risk: false, evidence: "e" }],
        };
      }
      return null;
    };

    const { prompts, schemas, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc", fixRound: true },
      agent,
    );

    expect(error).toBeUndefined();

    const reviewPrompt = prompts[0] ?? "";
    const runLine = reviewPrompt
      .split("\n")
      .find((line) => line.includes("mcp__penumbra__workflow_run"));
    expect(runLine ?? "").toContain('cwd="/tmp/x"');
    const waitLines = reviewPrompt
      .split("\n")
      .filter((line) => /(call|loop)\s+mcp__penumbra__workflow_wait/.test(line));
    expect(waitLines.length).toBeGreaterThan(0);
    for (const line of waitLines) {
      expect(line).toContain('cwd="/tmp/x"');
    }

    const fixPrompt = prompts.find((p) => p.includes("chain_start")) ?? "";
    expect(fixPrompt).toContain('caller_cwd="/tmp/x"');
    expect(prompts.join("\n")).not.toContain('caller_cwd="."');

    const properties = schemaProperties(schemas[0]);
    expect(properties.resolution_warning).toBeDefined();
    expect(properties.review_cwd).toBeDefined();
    expect(reviewPrompt).toContain("workflow_cwd_inferred_from_mcp_cwd");
  });
});
