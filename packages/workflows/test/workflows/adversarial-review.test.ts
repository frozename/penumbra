import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";
import type { z } from "zod";

import { AgentPerformanceWriter, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Plugin workflows live outside packages/ and so are not in the eslint
// tsconfig include — typed imports resolve to `any`. Wrap the dynamic import
// once and cast the exports to typed views, so the rest of the file lints
// with real type info.
import * as adversarialReviewModule from "../../../../plugin/workflows/adversarial-review/workflow.js";
import {
  loadAgentChatConfigFromDir,
  reloadAgentChatConfig,
} from "../../../config/src/files/load.js";

type ReviewModule = {
  default: WorkflowSpec;
  fn: WorkflowFn;
  inputSchema: z.ZodType;
  buildMemoryQuery: (...args: unknown[]) => string;
  buildPriorFindingsBlock: (...args: unknown[]) => string;
  diffTouchesUI: (...args: unknown[]) => boolean;
  summarizePersonaCompletionOutcome: (...args: unknown[]) => unknown;
};
const reviewMod = adversarialReviewModule as unknown as ReviewModule;
const spec = reviewMod.default;
const fn = reviewMod.fn;
const inputSchema = reviewMod.inputSchema;
const buildMemoryQuery = reviewMod.buildMemoryQuery;
const buildPriorFindingsBlock = reviewMod.buildPriorFindingsBlock;
const diffTouchesUI = reviewMod.diffTouchesUI;
const summarizePersonaCompletionOutcome = reviewMod.summarizePersonaCompletionOutcome;

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
      "git.diff": "diff --git a/a.ts b/a.ts",
      "git.show": [
        {
          sha: "abc123",
          subject: "feat: add thing",
          ts: "2026-05-08T00:00:00.000Z",
          body: "details",
        },
      ],
      "file.contents": {
        path: "/repo/src/a.ts",
        body: "export const a = 1;",
      },
    },
    warnings: [],
    estimatedTokens: 10,
  };
}

function recallWithDiff(diffText: string): RecallBundle {
  return {
    ...baseRecall(),
    byKey: {
      ...baseRecall().byKey,
      "git.diff": diffText,
    },
  };
}

type AdvReviewConfig = {
  personas: Record<
    string,
    {
      preferred_agent: string;
      bias: string;
      system_prompt: string;
      category_hints?: string[];
    }
  >;
  workloads: {
    review_adversarial: {
      eligible_agents: string[];
      fan_out: number;
      synthesizer: string | string[];
    };
  };
};

function makeConfig(): AdvReviewConfig {
  return {
    personas: {
      security: {
        preferred_agent: "security",
        bias: "security",
        system_prompt: "Prioritize exploitability and boundary correctness.",
        category_hints: ["security", "auth", "secrets"],
      },
      performance: {
        preferred_agent: "performance",
        bias: "performance",
        system_prompt: "Focus on latency, throughput, and hot paths.",
        category_hints: ["performance", "scaling"],
      },
      simplicity: {
        preferred_agent: "simplicity",
        bias: "simplicity",
        system_prompt: "Reduce moving parts and implementation complexity.",
        category_hints: ["maintainability", "simplicity"],
      },
      abc: {
        preferred_agent: "abc",
        bias: "abc",
        system_prompt: "Persona abc",
      },
      abd: {
        preferred_agent: "abd",
        bias: "abd",
        system_prompt: "Persona abd",
      },
    },
    workloads: {
      review_adversarial: {
        eligible_agents: ["security", "performance"],
        fan_out: 2,
        synthesizer: "codex",
      },
    },
  };
}

type DispatchInputReview = {
  agent: string;
  message: string;
  task_type?: string;
  task_class?: "BOUNDARY" | "STANDARD" | "TRIVIAL";
  use_worktree?: boolean;
};
type DispatchResultReview = { conversation_id: string; handoff_id: string };
type AwaitResultReview = {
  status: "completed" | "failed" | "timeout";
  final_agent: string | null;
  response_text: string | null;
};
type DispatchImplReview = (input: DispatchInputReview) => Promise<DispatchResultReview>;
type AwaitImplReview = (
  conversationId: string,
  opts?: { timeoutMs?: number },
) => Promise<AwaitResultReview>;

type MakeReviewCtxResult = {
  ctx: WorkflowCtx;
  root: string;
  writes: { path: string; body: string }[];
  dispatch: ReturnType<typeof mock<DispatchImplReview>>;
  awaitChain: ReturnType<typeof mock<AwaitImplReview>>;
};

function makeCtx(opts?: {
  args?: Record<string, unknown>;
  dispatchImpl?: DispatchImplReview;
  awaitImpl?: AwaitImplReview;
  db?: () => Database;
}): MakeReviewCtxResult {
  const root = mkdtempSync(join(tmpdir(), "adv-review-"));
  const writes: { path: string; body: string }[] = [];
  const defaultDispatch: DispatchImplReview = ({ agent }) =>
    Promise.resolve({
      conversation_id: `${agent}-conv`,
      handoff_id: `${agent}-handoff`,
    });
  const defaultAwait: AwaitImplReview = (conversationId) =>
    Promise.resolve({
      status: "completed" as const,
      final_agent: "agent",
      response_text: `review for ${conversationId}\n\n\`\`\`json\n[{"persona":"x","severity":"high","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n\`\`\``,
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
    db: opts?.db,
  };
  return { ctx, root, writes, dispatch, awaitChain };
}

function loadConfigWithRouting(routingYaml: string): ReturnType<typeof loadAgentChatConfigFromDir> {
  const dir = mkdtempSync(join(tmpdir(), "adv-review-config-"));
  writeFileSync(
    join(dir, "agents.yaml"),
    readFileSync(resolve("packages/config/test/files/fixtures/agents.yaml"), "utf8"),
  );
  writeFileSync(join(dir, "routing.yaml"), routingYaml);
  writeFileSync(
    join(dir, "quotas.yaml"),
    readFileSync(resolve("packages/config/test/files/fixtures/quotas.yaml"), "utf8"),
  );
  try {
    reloadAgentChatConfig();
    return loadAgentChatConfigFromDir(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reloadAgentChatConfig();
  }
}

function loadFixtureConfig(): ReturnType<typeof loadAgentChatConfigFromDir> {
  return loadConfigWithRouting(
    readFileSync(resolve("packages/config/test/files/fixtures/routing.yaml"), "utf8"),
  );
}

function parseSynthesisFrontmatter(content: string): Record<string, unknown> | null {
  // Allow an optional banner line before the frontmatter block
  const match = /---\n([\s\S]*?)\n---/.exec(content);
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

function writePerf(db: Database, agent: string, taskType: "review_adversarial"): void {
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
  expect(spec.name).toBe("adversarial-review");
  expect(spec.triggers).toEqual([
    { kind: "manual" },
    { kind: "slash", command: "adversarial-review" },
  ]);
  expect(spec.run).toEqual({ kind: "ts-function" });
});

test("inputSchema applies defaults and rejects unknown keys", () => {
  expect(inputSchema.parse({})).toEqual({
    target_ref: "HEAD",
    base_ref: "main",
    timeout_ms: 1800000,
  });
  expect(() => inputSchema.parse({ unexpected: true })).toThrow();
  expect(() => inputSchema.parse({ focus: "" })).toThrow();
  expect(() => inputSchema.parse({ focus: "x".repeat(3000) })).toThrow();
});

test("diffTouchesUI detects conservative user-visible UI file changes", () => {
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/App.tsx b/packages/console/src/App.tsx
--- a/packages/console/src/App.tsx
+++ b/packages/console/src/App.tsx
@@ -1 +1 @@
-old
+new`),
  ).toBe(true);
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/styles/theme.scss b/packages/console/src/styles/theme.scss
--- a/packages/console/src/styles/theme.scss
+++ b/packages/console/src/styles/theme.scss
@@ -1 +1 @@
-.old {}
+.new {}`),
  ).toBe(true);
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/components/Button.ts b/packages/console/src/components/Button.ts
--- a/packages/console/src/components/Button.ts
+++ b/packages/console/src/components/Button.ts
@@ -1 +1 @@
-export const label = "Save";
+export const label = "Submit";`),
  ).toBe(true);
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/App.test.tsx b/packages/console/src/App.test.tsx
--- a/packages/console/src/App.test.tsx
+++ b/packages/console/src/App.test.tsx
@@ -1 +1 @@
-old
+new`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git packages/console/src/components/Button.test.ts packages/console/src/components/Button.test.ts
--- packages/console/src/components/Button.test.ts
+++ packages/console/src/components/Button.test.ts
@@ -1 +1 @@
-old
+new`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/components/Button.spec.ts b/packages/console/src/components/Button.spec.ts
--- a/packages/console/src/components/Button.spec.ts
+++ b/packages/console/src/components/Button.spec.ts
@@ -1 +1 @@
-old
+new`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git a/packages/core/src/types.d.ts b/packages/core/src/types.d.ts
--- a/packages/core/src/types.d.ts
+++ b/packages/core/src/types.d.ts
@@ -1 +1 @@
-old
+new`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -1 +1 @@
-old
+new`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git "packages/console/src/components/Two Words.tsx" "packages/console/src/components/Two Words.tsx"
--- "packages/console/src/components/Two Words.tsx"
+++ "packages/console/src/components/Two Words.tsx"
@@ -1 +1 @@
-old
+new`),
  ).toBe(true);
  // A DELETED UI file is exactly the silent-drop case the vision reviewer exists
  // to catch: the only path lives on the `--- a/` header (`+++ /dev/null`).
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/components/OldPanel.tsx b/packages/console/src/components/OldPanel.tsx
deleted file mode 100644
--- a/packages/console/src/components/OldPanel.tsx
+++ /dev/null
@@ -1 +0,0 @@
-export const Panel = () => <button>Save</button>;`),
  ).toBe(true);
  // A newly ADDED UI file has its path on the `+++ b/` header (`--- /dev/null`).
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/components/NewPanel.tsx b/packages/console/src/components/NewPanel.tsx
new file mode 100644
--- /dev/null
+++ b/packages/console/src/components/NewPanel.tsx
@@ -0,0 +1 @@
+export const Panel = () => <button>Save</button>;`),
  ).toBe(true);
});

test("diffTouchesUI ignores forged path headers inside diff body content", () => {
  expect(
    diffTouchesUI(`diff --git a/packages/core/src/message.ts b/packages/core/src/message.ts
--- a/packages/core/src/message.ts
+++ b/packages/core/src/message.ts
@@ -1 +1 @@
-const text = "old";
+const text = "old";
+--- a/packages/console/src/App.tsx
+++ b/packages/console/src/App.tsx`),
  ).toBe(false);
  expect(
    diffTouchesUI(`diff --git a/packages/console/src/App.tsx b/packages/console/src/App.tsx
--- a/packages/console/src/App.tsx
+++ b/packages/console/src/App.tsx
@@ -1 +1 @@
-old
+new`),
  ).toBe(true);
});

test("optional persona failures are excluded from pass threshold using config metadata", () => {
  const outcome = summarizePersonaCompletionOutcome(
    [
      { persona: "security", status: "completed" },
      { persona: "ui_regression", persona_key: "ui_regression", status: "failed" },
    ],
    80,
    { ui_regression: { optional: true } },
  );
  expect(outcome.outcome).toBe("success_partial");
  expect(outcome.completedCount).toBe(1);
  expect(outcome.failedCount).toBe(1);
  expect(outcome.failedPersonas).toEqual(["ui_regression"]);
});

test("optional exemption keys off the stable persona_key, not the display name", () => {
  const outcome = summarizePersonaCompletionOutcome(
    [
      { persona: "security", persona_key: "security", status: "completed" },
      { persona: "UI Regression Check", persona_key: "ui_regression", status: "failed" },
    ],
    80,
    { ui_regression: { optional: true } },
  );
  expect(outcome.outcome).toBe("success_partial");
  expect(outcome.failedCount).toBe(1);
});

test("all-optional persona runs still require the selected personas to meet the pass threshold", () => {
  const outcome = summarizePersonaCompletionOutcome(
    [{ persona: "UI Regression Check", persona_key: "ui_regression", status: "failed" }],
    80,
    { ui_regression: { optional: true } },
  );
  expect(outcome.outcome).toBe("failed");
});

test("persona prompt includes caller focus when provided", async () => {
  const dispatchMessages: string[] = [];
  const { ctx, root } = makeCtx({
    args: {
      focus: "scrutinize the regex",
      personas: ["security"],
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
      personas: ["security"],
    },
    awaitImpl: (conversationId: string) => {
      if (conversationId === "claude-acp-sonnet-conv") {
        return {
          status: "completed",
          final_agent: "claude-acp-sonnet",
          response_text:
            'security review\n\n```json\n[{"persona":"security","severity":"high","category":"security","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
        };
      }
      return {
        status: "completed",
        final_agent: "codex",
        response_text: "synthesized review",
      };
    },
  });
  try {
    (ctx.config as Record<string, unknown>).personas = {
      security: {
        preferred_agent: "claude-acp-sonnet",
        bias: "security",
        system_prompt: "Prioritize exploitability and boundary correctness.",
      },
    };
    const review = (ctx.config.workloads as Record<string, unknown>).review_adversarial as Record<
      string,
      unknown
    >;
    review.eligible_agents = ["security"];
    review.fan_out = 1;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(dispatch.mock.calls[0]?.[0]?.agent).toBe("claude-acp-sonnet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("out_dir outside allowed roots is rejected", async () => {
  const { ctx, root } = makeCtx({
    args: {
      out_dir: "/tmp/external",
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("out_dir_outside_allowed_roots");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative out_dir resolves under cwd", async () => {
  const { ctx, root } = makeCtx({
    args: {
      out_dir: "./reviews/custom",
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    expect(result.out_dir).toBe(resolve(realpathSync(root), "reviews/custom"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all personas succeed: writes persona artifacts and synthesis with handoff_id frontmatter", async () => {
  const dispatchCalls: {
    agent: string;
    message: string;
    task_type?: string;
    use_worktree?: boolean;
  }[] = [];
  const { ctx, root, dispatch } = makeCtx();
  try {
    dispatch.mockImplementation(
      (input: { agent: string; message: string; task_type?: string; use_worktree?: boolean }) => {
        dispatchCalls.push(input);
        return Promise.resolve({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        });
      },
    );
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: { name: string; status: string; findings_count: number | null }[];
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toHaveLength(2);
    expect(result.synthesis_path).toBeTruthy();
    expect(result.synthesizer_status).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatchCalls).toHaveLength(3);
    expect(dispatchCalls[0]?.use_worktree).toBe(false);
    expect(dispatchCalls[0]?.task_class).toBe("TRIVIAL");
    expect(dispatchCalls[0]?.message.startsWith(`cd ${ctx.cwd}\n\n`)).toBe(true);
    expect(dispatchCalls[2]?.use_worktree).toBe(false);
    expect(dispatchCalls[2]?.task_class).toBe("TRIVIAL");
    expect(dispatchCalls[2]?.message.startsWith(`cd ${ctx.cwd}\n\n`)).toBe(true);
    await stat(join(result.out_dir, "security.json"));
    await stat(join(result.out_dir, "security.md"));
    await stat(join(result.out_dir, "performance.json"));
    await stat(join(result.out_dir, "performance.md"));
    await stat(join(result.out_dir, "synthesis.md"));
    const security = JSON.parse(await readFile(join(result.out_dir, "security.json"), "utf8")) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
    };
    expect(security.status).toBe("completed");
    expect(security.raw_status).toBe("completed");
    expect(security.triviality_reason).toBeUndefined();
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.review_run_ts).toBeString();
    expect(fm.synthesis_handoff_id).toBe("codex-handoff");
    expect(fm.target_ref).toBe("HEAD");
    expect(fm.base_ref).toBe("main");
    const personaIds = fm.persona_handoff_ids as Record<string, string>;
    expect(personaIds).toBeDefined();
    expect(personaIds.security).toBe("security-handoff");
    expect(personaIds.performance).toBe("performance-handoff");
    expect(synthContent).toContain("review for codex-conv");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one persona dispatch fails: workflow still synthesizes remaining results", async () => {
  const { ctx, root, dispatch } = makeCtx({
    dispatchImpl: ({ agent }) => {
      if (agent === "performance") {
        throw new Error("dispatch failed");
      }
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      outcome: string;
      out_dir: string;
      synthesis_path: string | null;
    };
    // 1 of 2 fails → 50% pass < 80% default threshold → outcome=failed, ok=false
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(3);
    const perf = JSON.parse(await readFile(join(result.out_dir, "performance.json"), "utf8")) as {
      status: string;
    };
    expect(perf.status).toBe("failed");
    expect(result.synthesis_path).toBeTruthy();
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.synthesis_handoff_id).toBe("codex-handoff");
    const personaIds = fm.persona_handoff_ids as Record<string, string>;
    expect(personaIds.security).toBe("security-handoff");
    expect(personaIds.performance).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all personas fail: synthesizer is not dispatched and synthesis_path is null", async () => {
  const { ctx, root, dispatch } = makeCtx({
    dispatchImpl: () => {
      throw new Error("no route");
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe("all_persona_dispatches_failed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all persona awaits fail: synthesizer is not dispatched and synthesis_path is null", async () => {
  const { ctx, root, dispatch } = makeCtx({
    awaitImpl: () =>
      Promise.resolve({
        status: "failed" as const,
        final_agent: null,
        response_text: null,
      }),
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe("all_persona_dispatches_failed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing review_adversarial workload config returns no_personas_configured", async () => {
  const { ctx, root } = makeCtx();
  try {
    const workloads = ctx.config.workloads as Record<string, unknown>;
    delete workloads.review_adversarial;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_personas_configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing review workload synthesizer returns no_synthesizer_configured", async () => {
  const { ctx, root } = makeCtx();
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    delete reviewWorkload.synthesizer;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_synthesizer_configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("args.personas selects only subset of configured personas", async () => {
  const { ctx, root, dispatch } = makeCtx({ args: { personas: ["security"] } });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      personas: { name: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.personas.map((p) => p.name)).toEqual(["security"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona selection dynamically includes optional category-hinted personas only for UI diffs when configured", async () => {
  const uiDiff = `diff --git a/packages/console/src/App.tsx b/packages/console/src/App.tsx
--- a/packages/console/src/App.tsx
+++ b/packages/console/src/App.tsx
@@ -1,3 +1,3 @@
-<button onClick={save}>Save</button>
+<button>Save</button>`;
  const nonUiDiff = `diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/docs/review.md b/docs/review.md
--- a/docs/review.md
+++ b/docs/review.md
@@ -1 +1 @@
-old
+new`;
  const configured = loadFixtureConfig();

  const withVision = makeCtx();
  try {
    withVision.ctx.config = configured;
    const result = (await fn(withVision.ctx, recallWithDiff(uiDiff))) as {
      ok: boolean;
      personas: { name: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.personas.map((persona) => persona.name)).toContain("vision_verify");
  } finally {
    rmSync(withVision.root, { recursive: true, force: true });
  }

  const nonUi = makeCtx();
  try {
    nonUi.ctx.config = configured;
    const result = (await fn(nonUi.ctx, recallWithDiff(nonUiDiff))) as {
      ok: boolean;
      personas: { name: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.personas.map((persona) => persona.name)).not.toContain("vision_verify");
  } finally {
    rmSync(nonUi.root, { recursive: true, force: true });
  }

  const withoutVision = makeCtx();
  try {
    withoutVision.ctx.config = {
      ...configured,
      personas: Object.fromEntries(
        Object.entries(configured.personas ?? {}).filter(([key]) => key !== "vision_verify"),
      ),
    };
    const result = (await fn(withoutVision.ctx, recallWithDiff(uiDiff))) as {
      ok: boolean;
      personas: { name: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.personas.map((persona) => persona.name)).not.toContain("vision_verify");
  } finally {
    rmSync(withoutVision.root, { recursive: true, force: true });
  }
});

test("optional UI persona dispatch failure does not fail an otherwise successful UI review", async () => {
  const uiDiff = `diff --git a/packages/console/src/App.tsx b/packages/console/src/App.tsx
--- a/packages/console/src/App.tsx
+++ b/packages/console/src/App.tsx
@@ -1,3 +1,3 @@
-<button onClick={save}>Save</button>
+<button>Save</button>`;
  const configured = loadFixtureConfig();
  const { ctx, root } = makeCtx({
    dispatchImpl: ({ agent }) => {
      if (agent === "google-gemini-pro-acp") throw new Error("vision worker unavailable");
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  try {
    ctx.config = configured;
    const result = (await fn(ctx, recallWithDiff(uiDiff))) as {
      ok: boolean;
      outcome: string;
      failed_personas: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success_partial");
    expect(result.failed_personas).toEqual(["vision_verify"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional UI personas parse from routing config, activate on content_path path, and do not block threshold", async () => {
  const contentPath = join(tmpdir(), "UiReview.tsx");
  writeFileSync(
    contentPath,
    `export function UiReview() {
  return <button>Save</button>;
}
`,
  );
  const configured = loadConfigWithRouting(`default_roles:
  executor: claude-acp-sonnet
  reviewer: codex-acp-deep
  planner: gemini-acp-pro

role_routing:
  exploration_policy: unsampled-first

personas:
  security:
    preferred_agent: claude-acp-sonnet
    bias: security
    system_prompt: Prioritize exploitability and boundary correctness.
  ui_regression:
    preferred_agent: google-gemini-pro-acp
    bias: ui_regression
    system_prompt: Review UI-touching diffs for silent user-visible regressions.
    category_hints: [ui, frontend]
    optional: true

workloads:
  review_adversarial:
    eligible_roles:
      - reviewer
    eligible_agents:
      - security
    fan_out: 1
    synthesizer: claude-acp-sonnet
`);
  const { ctx, root } = makeCtx({
    args: { content_path: contentPath },
    dispatchImpl: ({ agent }) => {
      if (agent === "google-gemini-pro-acp") throw new Error("vision worker unavailable");
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  try {
    ctx.config = configured;
    const result = (await fn(ctx, {
      ...baseRecall(),
      byKey: {
        ...baseRecall().byKey,
        "git.diff": `diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -1 +1 @@
-old
+new`,
        "file.contents": {
          path: contentPath,
          body: readFileSync(contentPath, "utf8"),
        },
      },
    })) as {
      ok: boolean;
      outcome: string;
      failed_personas: string[];
      personas: { name: string; status: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success_partial");
    expect(result.personas.map((persona) => persona.name)).toEqual(["security", "ui_regression"]);
    expect(result.failed_personas).toEqual(["ui_regression"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(contentPath, { force: true });
  }
});

test("fuzzy-matches requested persona names and returns warnings", async () => {
  const { ctx, root, dispatch } = makeCtx({ args: { personas: ["simplifier"] } });
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.eligible_agents = ["security", "performance", "simplicity"];
    reviewWorkload.fan_out = 3;
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      warnings?: string[];
      personas: { name: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.personas.map((p) => p.name)).toEqual(["simplicity"]);
    expect(result.warnings).toEqual(["resolved 'simplifier' to 'simplicity'"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps unknown_personas when fuzzy match is ambiguous", async () => {
  const { ctx, root } = makeCtx({ args: { personas: ["abe"] } });
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.eligible_agents = ["abc", "abd"];
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      error?: string;
      missing_personas?: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_personas");
    expect(result.missing_personas).toEqual(["abe"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trivial response with no json findings is downgraded to failed", async () => {
  const { ctx, root } = makeCtx({
    awaitImpl: (conversationId: string) => {
      if (conversationId.startsWith("security")) {
        return {
          status: "completed",
          final_agent: "security",
          response_text: "Model set. Ready when you have a task.",
        };
      }
      return {
        status: "completed",
        final_agent: "performance",
        response_text:
          'ok\n\n```json\n[{"persona":"p","severity":"low","category":"style","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    // security trivial → failed; 1 of 2 personas complete = 50% < 80% default → ok=false
    expect(result.ok).toBe(false);
    const security = JSON.parse(await readFile(join(result.out_dir, "security.json"), "utf8")) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
      findings: unknown;
      parse_error?: string;
    };
    expect(security.status).toBe("failed");
    expect(security.raw_status).toBe("completed");
    expect(security.triviality_reason).toBe("trivial_response");
    expect(security.findings).toBeNull();
    expect(security.parse_error).toBe("no_json_block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("substantive response without findings is not downgraded", async () => {
  const longNoJson = `Let me read the key files and evaluate architecture choices.\n\n${"analysis ".repeat(40)}`;
  const { ctx, root } = makeCtx({
    awaitImpl: (conversationId: string) => {
      if (conversationId.startsWith("security")) {
        return {
          status: "completed",
          final_agent: "security",
          response_text: longNoJson,
        };
      }
      return {
        status: "completed",
        final_agent: "performance",
        response_text:
          'ok\n\n```json\n[{"persona":"p","severity":"low","category":"style","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    const security = JSON.parse(await readFile(join(result.out_dir, "security.json"), "utf8")) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
      findings: unknown;
      parse_error?: string;
    };
    expect(security.status).toBe("completed");
    expect(security.raw_status).toBe("completed");
    expect(security.triviality_reason).toBeUndefined();
    expect(security.findings).toBeNull();
    expect(security.parse_error).toBe("no_json_block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content_path mode injects content-mode preamble into persona dispatches", async () => {
  const dispatchMessages: string[] = [];
  const { ctx, root } = makeCtx({
    args: { content_path: "/repo/docs/state-of-penumbra.md" },
    dispatchImpl: (input) => {
      dispatchMessages.push(input.message);
      return Promise.resolve({
        conversation_id: `${input.agent}-conv`,
        handoff_id: `${input.agent}-handoff`,
      });
    },
  });
  try {
    await fn(ctx, baseRecall());
    // First 2 dispatches are personas; 3rd is synthesizer
    expect(dispatchMessages.length).toBeGreaterThanOrEqual(2);
    for (const msg of dispatchMessages.slice(0, 2)) {
      expect(msg).toContain("Content-mode review");
      expect(msg).toContain("out of scope");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diff mode does not inject content-mode preamble into persona dispatches", async () => {
  const dispatchMessages: string[] = [];
  const { ctx, root } = makeCtx({
    // no content_path — diff mode
    dispatchImpl: (input) => {
      dispatchMessages.push(input.message);
      return Promise.resolve({
        conversation_id: `${input.agent}-conv`,
        handoff_id: `${input.agent}-handoff`,
      });
    },
  });
  try {
    await fn(ctx, baseRecall());
    expect(dispatchMessages.length).toBeGreaterThanOrEqual(2);
    for (const msg of dispatchMessages.slice(0, 2)) {
      expect(msg).not.toContain("Content-mode review");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome=success when all personas complete", async () => {
  const { ctx, root } = makeCtx();
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      outcome: string;
      failed_personas: string[];
      completed_personas: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.failed_personas).toEqual([]);
    expect(result.completed_personas).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome=success_partial when pass rate meets threshold", async () => {
  const { ctx, root } = makeCtx({
    dispatchImpl: ({ agent }) => {
      if (agent === "performance") throw new Error("timed out");
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  // 1 of 2 fails → 50% pass; set threshold to 45 so 50% >= 45% → success_partial
  ctx.config.review_min_personas_pass_pct = 45;
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      outcome: string;
      failed_personas: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success_partial");
    expect(result.failed_personas).toEqual(["performance"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome=failed and ok=false when pass rate falls below threshold", async () => {
  const { ctx, root } = makeCtx({
    dispatchImpl: ({ agent }) => {
      if (agent === "performance") throw new Error("timed out");
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  // 1 of 2 fails → 50% pass < 80% default threshold → failed
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      outcome: string;
      failed_personas: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.failed_personas).toContain("performance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthesis banner is prepended when persona failures occur", async () => {
  const { ctx, root } = makeCtx({
    dispatchImpl: ({ agent }) => {
      if (agent === "performance") throw new Error("timed out");
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
  });
  ctx.config.review_min_personas_pass_pct = 45; // success_partial so synthesis runs
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
    };
    expect(result.synthesis_path).toBeTruthy();
    const synthContent = await readFile(result.synthesis_path!, "utf8");
    expect(synthContent).toMatch(/^> Partial review: /);
    expect(synthContent).toContain("1 of 2 personas completed");
    expect(synthContent).toContain("performance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthesis banner is absent on clean success", async () => {
  const { ctx, root } = makeCtx();
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.synthesis_path).toBeTruthy();
    const synthContent = await readFile(result.synthesis_path!, "utf8");
    expect(synthContent).not.toMatch(/^> Partial review:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthesizer pool resolves through pressure without changing persona fan-out", async () => {
  const db = freshDb();
  writePerf(db, "claude-acp-sonnet", "review_adversarial");
  writePerf(db, "codex-acp-deep", "review_adversarial");
  writePressure(db, "anthropic", 95);
  writePressure(db, "openai", 5);
  const { ctx, root, dispatch } = makeCtx({ args: { personas: ["security"] } });
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
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.synthesizer = ["claude-acp-sonnet", "codex-acp-deep"];

    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
    };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]?.agent).toBe("security");
    expect(dispatch.mock.calls[1]?.[0]?.agent).toBe("codex-acp-deep");
    const synthContent = await readFile(join(result.out_dir, "synthesis.md"), "utf8");
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm?.synthesizer_agent).toBe("codex-acp-deep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries persona dispatch once on 503 no_worker_registered and records retry_count", async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"] },
    dispatchImpl: ((): DispatchImplReview => {
      let securityAttempts = 0;
      return ({ agent }) => {
        if (agent === "security") {
          securityAttempts += 1;
          if (securityAttempts === 1) {
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
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    const security = JSON.parse(await readFile(join(result.out_dir, "security.json"), "utf8")) as {
      status: string;
      retry_count?: number;
    };
    expect(security.status).toBe("completed");
    expect(security.retry_count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("retries synthesizer once on 503 no_worker_registered and annotates synthesis", async () => {
  const synthAgents: string[] = [];
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"] },
    dispatchImpl: ((): DispatchImplReview => {
      let synthAttempts = 0;
      return ({ agent }) => {
        if (agent === "codex") {
          synthAgents.push(agent);
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
    awaitImpl: (conversationId: string) => {
      if (conversationId === "codex-conv") {
        return {
          status: "completed",
          final_agent: "codex",
          response_text: "final synthesizer text",
        };
      }
      return {
        status: "completed",
        final_agent: "security",
        response_text:
          'security review\n\n```json\n[{"persona":"security","severity":"high","category":"security","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(synthAgents).toEqual(["codex", "codex"]);
    expect(result.synthesis_path).toBeTruthy();
    const synthesis = await readFile(result.synthesis_path!, "utf8");
    expect(synthesis).toContain("> Synthesizer retried once after 503 no_worker_registered");
    expect(synthesis).toContain("final synthesizer text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("fails over synthesizer pool when completed output is the failure marker", async () => {
  const synthAgents: string[] = [];
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"] },
    dispatchImpl: ({ agent }) => {
      if (agent === "codex" || agent === "gemini") synthAgents.push(agent);
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
    awaitImpl: (conversationId: string) => {
      if (conversationId === "codex-conv") {
        return {
          status: "completed",
          final_agent: "codex",
          response_text: "<synthesizer failed: failed>",
        };
      }
      if (conversationId === "gemini-conv") {
        return {
          status: "completed",
          final_agent: "gemini",
          response_text: "final synthesizer text",
        };
      }
      return {
        status: "completed",
        final_agent: "security",
        response_text:
          'security review\n\n```json\n[{"persona":"security","severity":"high","category":"security","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
      };
    },
  });
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.synthesizer = ["codex", "gemini"];

    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(synthAgents).toEqual(["codex", "gemini"]);
    expect(result.synthesis_path).toBeTruthy();
    const synthesis = await readFile(result.synthesis_path!, "utf8");
    const fm = parseSynthesisFrontmatter(synthesis);
    expect(fm?.synthesizer_agent).toBe("gemini");
    expect(fm?.synthesizer_failover_from).toBe("codex");
    expect(fm?.synthesizer_failover_to).toBe("gemini");
    expect(synthesis).toContain("> Synthesizer failover: codex -> gemini");
    expect(synthesis).toContain("final synthesizer text");
    expect(synthesis).not.toContain("<synthesizer failed: failed>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not fail over when a long synthesis merely quotes the failure marker", async () => {
  const synthAgents: string[] = [];
  const quotingSynthesis = `<synthesizer failed: failed> is the marker this review discusses.\n\n${"The synthesis itself succeeded and analyzes the failover handling in depth. ".repeat(10)}`;
  const { ctx, root } = makeCtx({
    args: { personas: ["security"] },
    dispatchImpl: ({ agent }) => {
      if (agent === "codex" || agent === "gemini") synthAgents.push(agent);
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
    awaitImpl: (conversationId: string) => {
      if (conversationId === "codex-conv") {
        return {
          status: "completed",
          final_agent: "codex",
          response_text: quotingSynthesis,
        };
      }
      return {
        status: "completed",
        final_agent: "security",
        response_text:
          'security review\n\n```json\n[{"persona":"security","severity":"high","category":"security","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
      };
    },
  });
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.synthesizer = ["codex", "gemini"];

    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null };
    expect(result.ok).toBe(true);
    expect(synthAgents).toEqual(["codex"]);
    const synthesis = await readFile(result.synthesis_path!, "utf8");
    const fm = parseSynthesisFrontmatter(synthesis);
    expect(fm?.synthesizer_agent).toBe("codex");
    expect(fm?.synthesizer_failover_from).toBeUndefined();
    expect(synthesis).toContain("is the marker this review discusses");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caps synthesis failover when every pool agent returns a failure marker", async () => {
  const synthAgents: string[] = [];
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"] },
    dispatchImpl: ({ agent }) => {
      if (agent === "codex" || agent === "gemini") synthAgents.push(agent);
      return Promise.resolve({ conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` });
    },
    awaitImpl: (conversationId: string) => {
      if (conversationId === "codex-conv" || conversationId === "gemini-conv") {
        return {
          status: "completed",
          final_agent: conversationId.replace("-conv", ""),
          response_text: "<synthesizer failed: failed>",
        };
      }
      return {
        status: "completed",
        final_agent: "security",
        response_text:
          'security review\n\n```json\n[{"persona":"security","severity":"high","category":"security","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
      };
    },
  });
  try {
    const reviewWorkload = (ctx.config.workloads as Record<string, unknown>)
      .review_adversarial as Record<string, unknown>;
    reviewWorkload.synthesizer = ["codex", "gemini"];

    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.synthesizer_status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(synthAgents).toEqual(["codex", "gemini"]);
    expect(result.synthesis_path).toBeTruthy();
    const synthesis = await readFile(result.synthesis_path!, "utf8");
    expect(synthesis).toContain("> Synthesizer failover: codex -> gemini");
    expect(synthesis).toContain("<synthesizer failed: failed>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Prior-findings (memory recall) integration ──────────────────────────────

function insertT2Memory(
  db: Database,
  id: string,
  title: string,
  body: string,
  ts = "2026-05-05T00:00:00Z",
): void {
  db.prepare(
    `INSERT INTO t2_memories (
       memory_id, project_id, user_id, kind,
       source_session_ids, window_start, window_end,
       title, body, metadata_json, created_at, updated_at,
       obs_type, concepts, severity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    null,
    "u1",
    "observation",
    JSON.stringify([id]),
    ts,
    ts,
    title,
    body,
    "{}",
    ts,
    ts,
    "note",
    JSON.stringify([]),
    "low",
  );
}

test("buildPriorFindingsBlock: empty hits returns null", () => {
  expect(buildPriorFindingsBlock([])).toBeNull();
});

test("buildPriorFindingsBlock: formats hits into advisory block", () => {
  const block = buildPriorFindingsBlock([
    { title: "Auth bypass found", snippet: "JWT tokens not validated in middleware" },
    { title: "SQL injection risk", snippet: "User input concatenated directly into query" },
  ]);
  expect(block).not.toBeNull();
  expect(block).toContain("Prior related findings (advisory — verify against current code)");
  expect(block).toContain("**Auth bypass found**");
  expect(block).toContain("JWT tokens not validated");
  expect(block).toContain("**SQL injection risk**");
});

test("buildPriorFindingsBlock: byte budget caps output", () => {
  // "- **Finding A**: " prefix (~17 chars) + 1940 chars = 1957 ≤ 2000 budget → included
  // After that bytes=1958; "- **Finding B**: short..." (~57 chars) → 2015 > 2000 → excluded
  const longSnippet = "x".repeat(1940);
  const hits = [
    { title: "Finding A", snippet: longSnippet },
    { title: "Finding B", snippet: "short snippet that would exceed budget" },
  ];
  const block = buildPriorFindingsBlock(hits);
  expect(block).not.toBeNull();
  expect(block).toContain("Finding A");
  expect(block).not.toContain("Finding B");
});

test("buildMemoryQuery: returns focus when provided", () => {
  const recall = baseRecall();
  const args = inputSchema.parse({ focus: "security vulnerabilities in auth" });
  expect(buildMemoryQuery(recall, args)).toBe("security vulnerabilities in auth");
});

test("buildMemoryQuery: extracts paths from diff when no focus", () => {
  const recall = recallWithDiff(
    `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new`,
  );
  const args = inputSchema.parse({});
  const query = buildMemoryQuery(recall, args);
  expect(query).toContain("src/auth.ts");
});

test("buildMemoryQuery: falls back to default when diff has no paths", () => {
  const recall = recallWithDiff("");
  const args = inputSchema.parse({});
  expect(buildMemoryQuery(recall, args)).toBe("code review findings");
});

test("fn: PENUMBRA_REVIEW_MEMORY_CONTEXT unset -> no prior findings in dispatch message", async () => {
  delete process.env.PENUMBRA_REVIEW_MEMORY_CONTEXT;
  const db = freshDb();
  insertT2Memory(db, "m1", "Old auth bug", "JWT tokens were not validated");
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"] },
    db: () => db,
  });
  try {
    await fn(ctx, baseRecall());
    const messages: string[] = dispatch.mock.calls.map((c: unknown[]) => {
      const arg = c[0] as { message?: string };
      return arg.message ?? "";
    });
    expect(messages.some((m) => m.includes("Prior related findings"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fn: PENUMBRA_REVIEW_MEMORY_CONTEXT=1, DB has matches -> prior findings block in dispatch message", async () => {
  process.env.PENUMBRA_REVIEW_MEMORY_CONTEXT = "1";
  const db = freshDb();
  // FTS5 requires ALL query tokens to appear somewhere in the row; put all three in body
  insertT2Memory(
    db,
    "m1",
    "Auth bypass security finding",
    "JWT tokens not validated in auth security middleware",
  );
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"], focus: "auth security JWT" },
    db: () => db,
  });
  try {
    await fn(ctx, baseRecall());
    const personaMessages: string[] = dispatch.mock.calls
      .filter((c: unknown[]) => {
        const arg = c[0] as { task_type?: string };
        return arg.task_type === "review_adversarial";
      })
      .map((c: unknown[]) => {
        const arg = c[0] as { message?: string };
        return arg.message ?? "";
      });
    expect(personaMessages.length).toBeGreaterThan(0);
    expect(personaMessages.every((m) => m.includes("Prior related findings"))).toBe(true);
    expect(personaMessages.every((m) => m.includes("advisory — verify against current code"))).toBe(
      true,
    );
  } finally {
    delete process.env.PENUMBRA_REVIEW_MEMORY_CONTEXT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fn: PENUMBRA_REVIEW_MEMORY_CONTEXT=1, empty DB -> no prior findings block", async () => {
  process.env.PENUMBRA_REVIEW_MEMORY_CONTEXT = "1";
  const db = freshDb();
  const { ctx, root, dispatch } = makeCtx({
    args: { personas: ["security"], focus: "auth security" },
    db: () => db,
  });
  try {
    await fn(ctx, baseRecall());
    const personaMessages: string[] = dispatch.mock.calls
      .filter((c: unknown[]) => {
        const arg = c[0] as { task_type?: string };
        return arg.task_type === "review_adversarial";
      })
      .map((c: unknown[]) => {
        const arg = c[0] as { message?: string };
        return arg.message ?? "";
      });
    expect(personaMessages.length).toBeGreaterThan(0);
    expect(personaMessages.every((m) => !m.includes("Prior related findings"))).toBe(true);
  } finally {
    delete process.env.PENUMBRA_REVIEW_MEMORY_CONTEXT;
    rmSync(root, { recursive: true, force: true });
  }
});

test("awaitChain uses persona timeout_ms override when configured", async () => {
  const seenTimeouts: number[] = [];
  const { ctx, root } = makeCtx({
    args: { personas: ["security"] },
    awaitImpl: (_conversationId, options) => {
      seenTimeouts.push(options?.timeoutMs ?? -1);
      return {
        status: "completed",
        final_agent: "agent",
        response_text:
          'ok\n\n```json\n[{"persona":"x","severity":"high","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
      };
    },
  });
  try {
    const personas = ctx.config.personas as Record<string, unknown>;
    const security = personas.security as Record<string, unknown>;
    security.timeout_ms = 50;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(seenTimeouts[0]).toBe(50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
