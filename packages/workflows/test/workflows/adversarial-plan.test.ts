import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";
import type { z } from "zod";

import { AgentPerformanceWriter, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Plugin workflows live outside packages/ and so are not in the eslint
// tsconfig include — typed imports resolve to `any`. Wrap the dynamic import
// once and cast the exports to the @penumbra/workflows types this test relies
// on, so the rest of the file lints with real type info.
import * as adversarialPlanModule from "../../../../plugin/workflows/adversarial-plan/workflow.js";

const spec = (adversarialPlanModule as unknown as { default: WorkflowSpec }).default;
const fn = (adversarialPlanModule as unknown as { fn: WorkflowFn }).fn;
const inputSchema = (adversarialPlanModule as unknown as { inputSchema: z.ZodType }).inputSchema;

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

const NOW = new Date(Date.now() - 60_000).toISOString();

function baseRecall(): RecallBundle {
  return {
    byKey: {
      "file.contents": {
        path: "/repo/specs/plan.md",
        body: "# Spec\n\nBuild the thing.",
      },
    },
    warnings: [],
    estimatedTokens: 10,
  };
}

type AdvPlanConfig = {
  personas: Record<string, { preferred_agent: string; bias: string; system_prompt: string }>;
  workloads: {
    plan_refine: {
      eligible_agents: string[];
      fan_out: number;
      synthesizer: string | string[];
    };
  };
};

function makeConfig(): AdvPlanConfig {
  return {
    personas: {
      architect: {
        preferred_agent: "architect",
        bias: "architect",
        system_prompt: "Review architecture trade-offs and sequencing risks.",
      },
      simplifier: {
        preferred_agent: "simplifier",
        bias: "simplifier",
        system_prompt: "Prefer the smallest viable implementation path.",
      },
      "test-first": {
        preferred_agent: "test-first",
        bias: "test-first",
        system_prompt: "Force explicit failing tests and narrow implementation.",
      },
      risk: {
        preferred_agent: "risk",
        bias: "risk",
        system_prompt: "Prioritize outage, regressions, and rollback concerns.",
      },
      integration: {
        preferred_agent: "integration",
        bias: "integration",
        system_prompt: "Focus on boundary integration and deployment ordering.",
      },
    },
    workloads: {
      plan_refine: {
        eligible_agents: ["architect", "simplifier", "test-first", "risk", "integration"],
        fan_out: 5,
        synthesizer: "codex",
      },
    },
  };
}

type DispatchInput = {
  agent: string;
  message: string;
  task_type?: string;
  task_class?: "BOUNDARY" | "STANDARD" | "TRIVIAL";
  use_worktree?: boolean;
};
type DispatchResult = { conversation_id: string; handoff_id: string };
type AwaitResult = {
  status: "completed" | "failed" | "timeout";
  response_text: string | null;
};
type DispatchImpl = (input: DispatchInput) => Promise<DispatchResult>;
type AwaitImpl = (conversationId: string, opts?: { timeoutMs?: number }) => Promise<AwaitResult>;

type MakeCtxResult = {
  ctx: WorkflowCtx;
  root: string;
  writes: { path: string; body: string }[];
  dispatch: ReturnType<typeof mock<DispatchImpl>>;
  awaitChain: ReturnType<typeof mock<AwaitImpl>>;
};

function makeCtx(opts?: {
  args?: Record<string, unknown>;
  dispatchImpl?: DispatchImpl;
  awaitImpl?: AwaitImpl;
}): MakeCtxResult {
  const root = mkdtempSync(join(tmpdir(), "adv-plan-"));
  const writes: { path: string; body: string }[] = [];
  const defaultDispatch: DispatchImpl = ({ agent }) =>
    Promise.resolve({
      conversation_id: `${agent}-conv`,
      handoff_id: `${agent}-handoff`,
    });
  const defaultAwait: AwaitImpl = (conversationId) =>
    Promise.resolve({
      status: "completed" as const,
      response_text: `plan for ${conversationId}`,
    });
  const dispatch = mock(opts?.dispatchImpl ?? defaultDispatch);
  const awaitChain = mock(opts?.awaitImpl ?? defaultAwait);

  const parsedArgs = inputSchema.parse(opts?.args ?? {}) as Record<string, unknown>;
  const ctx: WorkflowCtx = {
    dispatch,
    awaitChain,
    fileWrite: async (relativePath, body): Promise<string> => {
      const path = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
      writes.push({ path, body });
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, body);
      return path;
    },
    config: makeConfig(),
    cwd: root,
    storageRoot: root,
    project: "penumbra",
    args: parsedArgs,
  };

  return { ctx, root, writes, dispatch, awaitChain };
}

function parseSynthesisFrontmatter(content: string): Record<string, unknown> | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(db: Database, agent: string, taskType: "plan_refine"): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `${taskType}-${agent}`,
    ts: NOW,
    handoff_id: `handoff-${taskType}-${agent}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
    outcome: "merged",
    rounds: agent === "claude-acp-sonnet" ? 1 : 5,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: agent === "claude-acp-sonnet" ? 10_000 : 60_000,
    source: "test",
    notes: null,
    metadata_json: "{}",
  });
}

function writePressure(db: Database, provider: string, usedPct: number): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    `pressure-${provider}`,
    NOW,
    NOW,
    provider,
    JSON.stringify({
      window_label: "24h",
      model: null,
      used_pct: usedPct,
      resets_at: null,
      source_kind: "subscription",
    }),
  );
}

test("spec metadata is registered as manual + slash ts-function workflow", () => {
  expect(spec.name).toBe("adversarial-plan");
  expect(spec.triggers).toEqual([
    { kind: "manual" },
    { kind: "slash", command: "adversarial-plan" },
  ]);
  expect(spec.run).toEqual({ kind: "ts-function" });
});

test("inputSchema applies defaults and rejects unknown keys", () => {
  expect(inputSchema.parse({})).toEqual({
    timeout_ms: 1800000,
  });
  expect(() => inputSchema.parse({ unexpected: true })).toThrow();
  expect(() => inputSchema.parse({ focus: "" })).toThrow();
  expect(() => inputSchema.parse({ focus: "x".repeat(3000) })).toThrow();
});

test("persona prompt includes caller focus when provided", async () => {
  const dispatchMessages: string[] = [];
  const { ctx, root } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect"],
      focus: "scrutinize the regex",
    },
    dispatchImpl: (input) => {
      dispatchMessages.push(input.message);
      return Promise.resolve({
        conversation_id: `${input.agent}-conv`,
        handoff_id: `${input.agent}-handoff`,
      });
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(dispatchMessages.length).toBeGreaterThanOrEqual(1);
    expect(dispatchMessages[0]).toContain("## Caller's focus");
    expect(dispatchMessages[0]).toContain("scrutinize the regex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona mapping uses personas.<name>.preferred_agent, not workload key", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect"],
    },
    awaitImpl: (conversationId: string) =>
      Promise.resolve(
        conversationId === "claude-acp-sonnet-conv"
          ? { status: "completed" as const, response_text: "architect plan" }
          : { status: "completed" as const, response_text: "synthesized plan" },
      ),
  });
  try {
    (ctx.config as Record<string, unknown>).personas = {
      architect: {
        preferred_agent: "claude-acp-sonnet",
        bias: "architect",
        system_prompt: "Review architecture trade-offs and sequencing risks.",
      },
    };
    const planRefine = (ctx.config.workloads as Record<string, unknown>).plan_refine as Record<
      string,
      unknown
    >;
    planRefine.eligible_agents = ["architect"];
    planRefine.fan_out = 1;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(dispatch.mock.calls[0]?.[0]?.agent).toBe("claude-acp-sonnet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("happy path: two personas complete, synthesizer runs, and synthesis is written", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "simplifier"],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: { name: string; status: string; conversation_id: string | null }[];
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toEqual([
      { name: "architect", status: "completed", conversation_id: "architect-conv" },
      { name: "simplifier", status: "completed", conversation_id: "simplifier-conv" },
    ]);
    expect(result.synthesis_path).toBe(join(result.out_dir, "synthesis.md"));
    expect(result.synthesizer_status).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls[0]?.[0]?.use_worktree).toBe(false);
    expect(dispatch.mock.calls[0]?.[0]?.task_class).toBe("TRIVIAL");
    expect(dispatch.mock.calls[2]?.[0]?.use_worktree).toBe(false);
    expect(dispatch.mock.calls[2]?.[0]?.task_class).toBe("TRIVIAL");
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.topic).toBe("Ship a planning workflow");
    expect(fm.personas).toBe("architect, simplifier");
    expect(fm.synthesis_handoff_id).toBe("codex-handoff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one persona fails: synth still runs with surviving persona only", async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "simplifier"],
    },
    dispatchImpl: ((): DispatchImpl => {
      let call = 0;
      return ({ agent }) => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ conversation_id: "claude-conv", handoff_id: "claude-handoff" });
        }
        if (call === 2) {
          return Promise.resolve({ conversation_id: "codex-conv", handoff_id: "codex-handoff" });
        }
        return Promise.resolve({
          conversation_id: `${agent}-synth-conv`,
          handoff_id: `${agent}-synth-handoff`,
        });
      };
    })(),
    awaitImpl: (conversationId: string) => {
      if (conversationId === "claude-conv") {
        return Promise.resolve({
          status: "completed" as const,
          response_text: "architect plan",
        });
      }
      if (conversationId === "codex-conv") {
        return Promise.resolve({
          status: "failed" as const,
          response_text: null,
        });
      }
      if (conversationId === "codex-synth-conv") {
        return Promise.resolve({
          status: "completed" as const,
          response_text: "synthesized plan",
        });
      }
      return Promise.resolve({
        status: "failed" as const,
        response_text: null,
      });
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: { name: string; status: string; conversation_id: string | null }[];
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toEqual([
      { name: "architect", status: "completed", conversation_id: "claude-conv" },
      { name: "simplifier", status: "failed", conversation_id: "codex-conv" },
    ]);
    expect(result.synthesis_path).toBe(join(result.out_dir, "synthesis.md"));
    expect(result.synthesizer_status).toBe("completed");
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    expect(synthContent).toContain("synthesized plan");
    expect(synthContent).not.toContain("simplifier plan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all personas fail: synth does not run and synthesis_path is null", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "simplifier"],
    },
    dispatchImpl: () => {
      throw new Error("dispatch failed");
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
      error?: string;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe("all_persona_dispatches_failed");
    expect(result.synthesizer_status).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown_personas error when args.personas includes an unconfigured name", async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "ghost"],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      error?: string;
      missing_personas?: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_personas");
    expect(result.missing_personas).toEqual(["ghost"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no_personas_configured error when plan_refine workload has no eligible agents", async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
    },
  });
  try {
    const planRefine = (ctx.config.workloads as Record<string, unknown>).plan_refine as Record<
      string,
      unknown
    >;
    planRefine.eligible_agents = [];
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_personas_configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no_topic_or_content error when neither topic nor content_path is provided", async () => {
  const { ctx, root } = makeCtx();
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_topic_or_content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synth dispatch message includes the anti-derail preamble and uses workload synthesizer", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "simplifier"],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.synthesizer_status).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(3);
    const synthCall = dispatch.mock.calls[2]?.[0] as { message: string } | undefined;
    const synthMessage = synthCall?.message ?? "";
    expect(synthMessage).toContain("You are the synthesizer for an /adversarial-plan fan-out");
    expect(synthMessage).toContain("This is NOT a session start");
    expect(synthMessage).toContain("Do not run first moves");
    expect(synthMessage).toContain("Do not check git status");
    expect(synthMessage).toContain("Do not output status summaries");
    const synthAgentCall = dispatch.mock.calls[2]?.[0] as { agent?: string } | undefined;
    expect(synthAgentCall?.agent).toBe("codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthesizer pool resolves through pressure without changing persona fan-out", async () => {
  const db = freshDb();
  writePerf(db, "claude-acp-sonnet", "plan_refine");
  writePerf(db, "codex-acp-deep", "plan_refine");
  writePressure(db, "anthropic", 95);
  writePressure(db, "openai", 5);
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect"],
    },
  });
  try {
    ctx.db = (): Database => db;
    ctx.config.agents = [
      {
        name: "claude-acp-sonnet",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "codex-acp-deep",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: "openai",
      },
    ];
    const planRefine = (ctx.config.workloads as Record<string, unknown>).plan_refine as Record<
      string,
      unknown
    >;
    planRefine.synthesizer = ["claude-acp-sonnet", "codex-acp-deep"];

    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
    };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]?.agent).toBe("architect");
    expect(dispatch.mock.calls[1]?.[0]?.agent).toBe("codex-acp-deep");
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm?.synthesizer_agent).toBe("codex-acp-deep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries synthesizer once on 503 no_worker_registered and annotates synthesis", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect"],
    },
    dispatchImpl: ((): DispatchImpl => {
      let synthAttempts = 0;
      return ({ agent }) => {
        if (agent === "codex") {
          synthAttempts += 1;
          if (synthAttempts === 1) {
            throw new Error(
              'chain.start failed with 503: {"error":{"code":"no_worker_registered"}}',
            );
          }
        }
        return Promise.resolve({
          conversation_id: `${agent}-conv`,
          handoff_id: `${agent}-handoff`,
        });
      };
    })(),
    awaitImpl: (conversationId: string) =>
      Promise.resolve(
        conversationId === "codex-conv"
          ? { status: "completed" as const, response_text: "final synthesizer text" }
          : { status: "completed" as const, response_text: "architect plan" },
      ),
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.synthesis_path).toBeTruthy();
    const synthesis = await readFile(result.synthesis_path!, "utf8");
    expect(synthesis).toContain("> Synthesizer retried once after 503 no_worker_registered");
    expect(synthesis).toContain("final synthesizer text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
