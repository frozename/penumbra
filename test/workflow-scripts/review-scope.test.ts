import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readRuntimeBody, runWorkflowCapturingPrompts } from "./harness.js";

const SWEEP = ".claude/workflows/penumbra-review-sweep.js";
const ADVERSARIAL = ".claude/workflows/adversarial-review.js";
const FANOUT = ".claude/workflows/penumbra-fanout.js";

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
type WorkflowStub = (name: string, wargs: unknown) => Promise<unknown>;

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
  workflowStub?: WorkflowStub,
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
  const workflow: WorkflowStub = workflowStub ?? (async () => ({}));

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

const LOOP = ".claude/workflows/penumbra-loop-discover-to-green.js";

describe("partial diff coverage is never a passed review", () => {
  const CLEAN_REVIEW = {
    outcome: "success",
    verdict: "land",
    high: [],
    medium: [],
    low: [],
    completed_personas: ["persona-a"],
    failed_personas: [],
  };

  test("adversarial-review schema + prompt carry diff_truncated and diff_dropped_files", async () => {
    const { prompts, schemas, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc" },
      async () => ({ ...CLEAN_REVIEW }),
    );

    expect(error).toBeUndefined();
    const properties = schemaProperties(schemas[0]);
    expect(properties.diff_truncated).toBeDefined();
    expect(properties.diff_dropped_files).toBeDefined();
    expect(prompts[0] ?? "").toContain("diff_truncated");
    expect(prompts[0] ?? "").toContain("diff_dropped_files");
  });

  test("adversarial-review schema REQUIRES diff_truncated/diff_dropped_files with explicit defaults", async () => {
    const { schemas, prompts, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc" },
      async () => ({ ...CLEAN_REVIEW }),
    );

    expect(error).toBeUndefined();
    const schema = schemas[0] as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    // Optional coverage fields let an omitting proxy pass a truncated review
    // as clean — required with an explicit default makes omission impossible.
    expect(schema.required).toContain("diff_truncated");
    expect(schema.required).toContain("diff_dropped_files");
    expect(schema.properties?.diff_truncated?.description ?? "").toContain("false");
    expect(schema.properties?.diff_dropped_files?.description ?? "").toContain("[]");
    expect(prompts.join("\n")).toContain("diff_truncated");
  });

  test("review-sweep schema REQUIRES diff_truncated/diff_dropped_files with explicit defaults", async () => {
    const { schemas, prompts, error } = await runReturning(
      SWEEP,
      { repo: "/tmp/x", targets: [{ target_ref: "abc" }] },
      async () => ({ ok: true, outcome: "success", diff_truncated: false }),
    );

    expect(error).toBeUndefined();
    const schema = schemas[0] as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.required).toContain("diff_truncated");
    expect(schema.required).toContain("diff_dropped_files");
    expect(schema.properties?.diff_truncated?.description ?? "").toContain("false");
    expect(schema.properties?.diff_dropped_files?.description ?? "").toContain("[]");
    expect(prompts.join("\n")).toContain("diff_truncated");
  });

  test("a diff_truncated review with zero HIGH recommends review_debt, not passed", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("review:")) {
        return {
          ...CLEAN_REVIEW,
          diff_truncated: true,
          diff_dropped_files: ["b.ts", "c.ts"],
        };
      }
      return null;
    };
    const { result, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc", laneId: "lane-1" },
      agent,
    );

    expect(error).toBeUndefined();
    const review = result as {
      diff_truncated?: boolean;
      diff_dropped_files?: string[];
      laneRecommendation?: { gate_status?: string };
    };
    expect(review.diff_truncated).toBe(true);
    expect(review.diff_dropped_files).toEqual(["b.ts", "c.ts"]);
    expect(review.laneRecommendation?.gate_status).toBe("review_debt");
  });

  test("a diff_truncated review WITH HIGH findings keeps the HIGH next message plus a coverage note", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("review:")) {
        return {
          ...CLEAN_REVIEW,
          high: [
            {
              id: "H1",
              severity: "HIGH",
              title: "unchecked write",
              detail: "detail",
            },
          ],
          diff_truncated: true,
          diff_dropped_files: ["b.ts"],
        };
      }
      return null;
    };
    const { result, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc", laneId: "lane-1" },
      agent,
    );

    expect(error).toBeUndefined();
    const review = result as {
      diff_truncated?: boolean;
      next?: string;
      laneRecommendation?: { gate_status?: string };
    };
    // gate_status is driven by the HIGH findings (round 1 -> failed); `next` must
    // agree: the HIGH message stays primary and partial coverage is a NOTE on it,
    // never a bare "high_count=0 is NOT clean" that contradicts the gate.
    expect(review.laneRecommendation?.gate_status).toBe("failed");
    expect(review.next ?? "").toMatch(/HIGH finding/);
    expect(review.next ?? "").not.toMatch(/high_count=0/);
    expect(review.next ?? "").toMatch(/partial|truncat/i);
  });

  test("a full-coverage review with zero HIGH still recommends passed", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label.startsWith("review:")) {
        return { ...CLEAN_REVIEW, diff_truncated: false };
      }
      return null;
    };
    const { result, error } = await runReturning(
      ADVERSARIAL,
      { repo: "/tmp/x", target_ref: "abc", laneId: "lane-1" },
      agent,
    );

    expect(error).toBeUndefined();
    const review = result as {
      diff_truncated?: boolean;
      laneRecommendation?: { gate_status?: string };
    };
    expect(review.diff_truncated).toBe(false);
    expect(review.laneRecommendation?.gate_status).toBe("passed");
  });

  test("review-sweep never counts a diff_truncated result as ok", async () => {
    const { result, prompts, schemas, error } = await runReturning(
      SWEEP,
      { repo: "/tmp/x", targets: [{ target_ref: "abc" }] },
      async () => ({
        ok: true,
        outcome: "success",
        diff_truncated: true,
        diff_dropped_files: ["b.ts"],
      }),
    );

    expect(error).toBeUndefined();
    const sweep = result as SweepReturn | undefined;
    expect(sweep?.ok).toBe(false);
    expect(sweep?.reviewed_ok).toBe(0);
    expect(sweep?.results?.[0]).toMatchObject({
      ok: false,
      diff_truncated: true,
      diff_dropped_files: ["b.ts"],
    });
    const properties = schemaProperties(schemas[0]);
    expect(properties.diff_truncated).toBeDefined();
    expect(properties.diff_dropped_files).toBeDefined();
    expect(prompts[0] ?? "").toContain("diff_truncated");
  });

  test("review-sweep keeps a full-coverage ok result ok", async () => {
    const { result, error } = await runReturning(
      SWEEP,
      { repo: "/tmp/x", targets: [{ target_ref: "abc" }] },
      async () => ({ ok: true, outcome: "success", diff_truncated: false }),
    );

    expect(error).toBeUndefined();
    const sweep = result as SweepReturn | undefined;
    expect(sweep?.ok).toBe(true);
    expect(sweep?.reviewed_ok).toBe(1);
  });

  test("discover-to-green does not mark a diff_truncated review clean", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label === "plan") {
        return {
          summary: "fix the bug",
          files: "x.ts",
          check_command: "bun test x.ts",
          spec: "tdd spec",
        };
      }
      return null;
    };
    const workflowStub: WorkflowStub = async (name) => {
      if (name === "penumbra-fanout") {
        return {
          results: [
            {
              ok: true,
              branch: "fix-b",
              handoff_id: "h1",
              response: "CHECK_RESULT: PASS\nall green",
            },
          ],
        };
      }
      if (name === "adversarial-review") {
        return {
          outcome: "success",
          verdict: "land",
          high: [],
          high_count: 0,
          medium_count: 0,
          low_count: 0,
          completed_personas: ["persona-a"],
          failed_personas: [],
          land_candidate: "fix-b",
          fix_rejected: false,
          diff_truncated: true,
          diff_dropped_files: ["b.ts"],
        };
      }
      return {};
    };
    const { result, error } = await runReturning(
      LOOP,
      {
        repo: "/tmp/x",
        seedCandidates: [
          {
            title: "real bug",
            severity: "HIGH",
            file: "x.ts:1",
            why_real: "concrete repro",
            fix_sketch: "fix it",
            suggested_check: "bun test x.ts",
          },
        ],
      },
      agent,
      workflowStub,
    );

    expect(error).toBeUndefined();
    const loop = result as {
      green_for_land?: boolean;
      review?: { diff_truncated?: boolean; diff_dropped_files?: string[] };
      next?: string;
    };
    expect(loop.green_for_land).toBe(false);
    expect(loop.review?.diff_truncated).toBe(true);
    expect(loop.review?.diff_dropped_files).toEqual(["b.ts"]);
    expect(loop.next ?? "").toMatch(/review_debt|TRUNCATED|partial/i);
  });

  test("discover-to-green leads with HIGH findings (partial-coverage note) when a truncated review has HIGH", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label === "plan") {
        return {
          summary: "fix the bug",
          files: "x.ts",
          check_command: "bun test x.ts",
          spec: "tdd spec",
        };
      }
      return null;
    };
    const workflowStub: WorkflowStub = async (name) => {
      if (name === "penumbra-fanout") {
        return {
          results: [
            {
              ok: true,
              branch: "fix-b",
              handoff_id: "h1",
              response: "CHECK_RESULT: PASS\nall green",
            },
          ],
        };
      }
      if (name === "adversarial-review") {
        return {
          outcome: "success",
          verdict: "changes",
          high: [{ id: "H1", severity: "HIGH", title: "unchecked write" }],
          high_count: 1,
          medium_count: 0,
          low_count: 0,
          completed_personas: ["persona-a"],
          failed_personas: [],
          land_candidate: "fix-b",
          fix_rejected: false,
          diff_truncated: true,
          diff_dropped_files: ["b.ts"],
        };
      }
      return {};
    };
    const { result, error } = await runReturning(
      LOOP,
      {
        repo: "/tmp/x",
        seedCandidates: [
          {
            title: "real bug",
            severity: "HIGH",
            file: "x.ts:1",
            why_real: "concrete repro",
            fix_sketch: "fix it",
            suggested_check: "bun test x.ts",
          },
        ],
      },
      agent,
      workflowStub,
    );

    expect(error).toBeUndefined();
    const loop = result as { green_for_land?: boolean; next?: string };
    expect(loop.green_for_land).toBe(false);
    expect(loop.next ?? "").toMatch(/HIGH finding/);
    expect(loop.next ?? "").not.toMatch(/high_count=0/);
    expect(loop.next ?? "").toMatch(/PARTIAL|truncat/i);
  });

  test("discover-to-green keeps a full-coverage zero-HIGH review clean", async () => {
    const agent: AgentStub = async (_prompt, options) => {
      const label = String(options?.label ?? "");
      if (label === "plan") {
        return {
          summary: "fix the bug",
          files: "x.ts",
          check_command: "bun test x.ts",
          spec: "tdd spec",
        };
      }
      return null;
    };
    const workflowStub: WorkflowStub = async (name) => {
      if (name === "penumbra-fanout") {
        return {
          results: [
            {
              ok: true,
              branch: "fix-b",
              handoff_id: "h1",
              response: "CHECK_RESULT: PASS\nall green",
            },
          ],
        };
      }
      if (name === "adversarial-review") {
        return {
          outcome: "success",
          verdict: "land",
          high: [],
          high_count: 0,
          medium_count: 0,
          low_count: 0,
          completed_personas: ["persona-a"],
          failed_personas: [],
          land_candidate: "fix-b",
          fix_rejected: false,
        };
      }
      return {};
    };
    const { result, error } = await runReturning(
      LOOP,
      {
        repo: "/tmp/x",
        seedCandidates: [
          {
            title: "real bug",
            severity: "HIGH",
            file: "x.ts:1",
            why_real: "concrete repro",
            fix_sketch: "fix it",
            suggested_check: "bun test x.ts",
          },
        ],
      },
      agent,
      workflowStub,
    );

    expect(error).toBeUndefined();
    const loop = result as { green_for_land?: boolean };
    expect(loop.green_for_land).toBe(true);
  });
});
