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
import { stubScratchWorktree } from "../../../../plugin/workflows/_shared/test-helpers.js";
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

// review_readonly dispatches only land on seats that opt into
// enforces_permission_profiles. Production gets those entries from
// agents.yaml; here the lazy getter re-derives them from the live config so
// tests that mutate ctx.config personas/workloads after makeCtx still see
// every referenced seat as enforcing.
function installEnforcingAgents<T extends object>(config: T): T {
  // Shallow-clone first: loader-produced configs may freeze `agents`.
  const wrapped = { ...(config as Record<string, unknown>) } as Record<string, unknown>;
  const seed = wrapped.agents;
  let override: unknown = Array.isArray(seed) ? seed : undefined;
  Object.defineProperty(wrapped, "agents", {
    enumerable: true,
    configurable: true,
    get: () => {
      const cfg = wrapped as {
        personas?: Record<string, { preferred_agent?: unknown }>;
        workloads?: Record<string, { eligible_agents?: unknown; synthesizer?: unknown }>;
        default_roles?: Record<string, unknown>;
      };
      const names = new Set<string>();
      const add = (v: unknown): void => {
        for (const n of Array.isArray(v) ? v : [v]) {
          if (typeof n === "string") names.add(n);
        }
      };
      for (const p of Object.values(cfg.personas ?? {})) add(p.preferred_agent);
      for (const w of Object.values(cfg.workloads ?? {})) {
        add(w.eligible_agents);
        add(w.synthesizer);
      }
      for (const roleAgent of Object.values(cfg.default_roles ?? {})) add(roleAgent);
      const enforce = (entry: Record<string, unknown>): Record<string, unknown> =>
        entry.enforces_permission_profiles === undefined
          ? { ...entry, enforces_permission_profiles: ["review_readonly"] }
          : entry;
      const out = Array.isArray(override)
        ? override.map((entry) => enforce(entry as Record<string, unknown>))
        : [];
      const seen = new Set(out.map((entry) => entry.name));
      for (const name of names) {
        if (!seen.has(name)) out.push(enforce({ name, roles: [] }));
      }
      return out;
    },
    set: (v) => {
      override = v;
    },
  });
  return wrapped as T;
}

type DispatchInput = {
  agent: string;
  message: string;
  task_type?: string;
  task_class?: "BOUNDARY" | "STANDARD" | "TRIVIAL";
  use_worktree?: boolean;
  permission_profile?: string | null;
};
type DispatchResult = {
  conversation_id: string;
  handoff_id: string;
  permission_profile?: string | null;
};
type AwaitResult = {
  status: "completed" | "failed" | "timeout";
  response_text: string | null;
  failure_reason?: string;
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
  // ctx.dispatch echoes the granted permission_profile back to the caller —
  // wrap impls so mocks honor the same contract the workflow asserts.
  const dispatchImpl = opts?.dispatchImpl ?? defaultDispatch;
  const dispatch = mock((input: DispatchInput) =>
    dispatchImpl(input).then((r) => ({ ...r, permission_profile: input.permission_profile })),
  );
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
    config: installEnforcingAgents(makeConfig()),
    cwd: root,
    storageRoot: root,
    project: "penumbra",
    // The scratch path is a stub — plan never trips a tripwire, and dispatch
    // inputs just carry it through cwd_override.
    scratchWorktree: stubScratchWorktree(join(root, ".scratch-test")),
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
      {
        name: "architect",
        status: "completed",
        conversation_id: "architect-conv",
        cancel_requested: false,
      },
      {
        name: "simplifier",
        status: "completed",
        conversation_id: "simplifier-conv",
        cancel_requested: false,
      },
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
      outcome: string;
      failed_personas: string[];
      out_dir: string;
      synthesis_path: string | null;
      personas: { name: string; status: string; conversation_id: string | null }[];
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success_partial");
    expect(result.failed_personas).toEqual(["simplifier"]);
    expect(result.personas).toEqual([
      {
        name: "architect",
        status: "completed",
        conversation_id: "claude-conv",
        cancel_requested: false,
      },
      {
        name: "simplifier",
        status: "failed",
        conversation_id: "codex-conv",
        cancel_requested: false,
      },
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

test("failed persona chains name their failure reason in the synthesis prompt and artifacts", async () => {
  const failures: Record<string, string> = {
    "simplifier-conv": "codex-acp exited 1\n  stderr: quota exhausted",
    "risk-conv": "completed_without_final_response",
  };
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: "Ship a planning workflow",
      personas: ["architect", "simplifier", "risk"],
    },
    awaitImpl: (conversationId) => {
      const failureReason = failures[conversationId];
      return Promise.resolve(
        failureReason === undefined
          ? { status: "completed" as const, response_text: `plan for ${conversationId}` }
          : { status: "failed" as const, response_text: null, failure_reason: failureReason },
      );
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { out_dir: string };
    const synthMessage = dispatch.mock.calls.find(([input]) => input.agent === "codex")?.[0]
      .message;
    expect(synthMessage).toContain(
      "### simplifier (simplifier)\nDISPATCH FAILED: codex-acp exited 1 stderr: quota exhausted",
    );
    expect(synthMessage).toContain(
      "### risk (risk)\nDISPATCH FAILED: completed_without_final_response",
    );
    expect(synthMessage).toContain("### architect (architect)\nplan for architect-conv");

    const simplifier = JSON.parse(
      await readFile(join(result.out_dir, "simplifier.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(simplifier.error).toBe("codex-acp exited 1 stderr: quota exhausted");
    expect(await readFile(join(result.out_dir, "risk.md"), "utf8")).toBe(
      "<dispatch failed: completed_without_final_response>",
    );
    const architect = JSON.parse(
      await readFile(join(result.out_dir, "architect.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(architect.status).toBe("completed");
    expect(architect).not.toHaveProperty("error");
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

test("installEnforcingAgents preserves an explicit enforces_permission_profiles opt-out", () => {
  const configured = installEnforcingAgents({
    ...makeConfig(),
    agents: [
      {
        name: "architect",
        roles: ["planner"],
        adapter: "stdio-acp",
        enforces_permission_profiles: [],
      },
    ],
  });
  const agents = (
    configured as unknown as {
      agents: { name: string; enforces_permission_profiles?: string[] }[];
    }
  ).agents;
  expect(agents.find((a) => a.name === "architect")?.enforces_permission_profiles).toEqual([]);
});
