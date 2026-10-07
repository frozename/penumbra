import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Input } from "./workflow.js";

import { emptyRecall, testWorkflowCtx } from "../_shared/test-helpers.js";
import workflowSpec, { fn, resolveRequestedPersonas } from "./workflow.js";

const WELL_FORMED_SYNTHESIS = `Land as-is.

## Shared concerns
none - single persona

## Contradictions
none

## Severity-ranked findings
none

## Recommended actions
none

## Skipped/failed personas
none`;

describe("resolveRequestedPersonas", () => {
  const available = ["security-paranoid", "performance-hawk", "ui-pragmatist"];

  test("collapses exact duplicates to one resolved entry", () => {
    const out = resolveRequestedPersonas(
      ["security-paranoid", "security-paranoid", "performance-hawk"],
      available,
    );
    expect(out.resolved).toEqual(["security-paranoid", "performance-hawk"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain("skipped duplicate persona 'security-paranoid'");
  });

  test("collapses fuzzy-duplicates that resolve to the same canonical name", () => {
    const out = resolveRequestedPersonas(["security-paranoid", "security-paranoyd"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain(
      "skipped duplicate persona 'security-paranoyd' (resolves to 'security-paranoid')",
    );
  });

  test("two fuzzy variants that map to the same canonical collapse to one entry", () => {
    const out = resolveRequestedPersonas(["security-paranoyd", "security-paranoide"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toContain("resolved 'security-paranoyd' to 'security-paranoid'");
    expect(out.warnings).toContain(
      "skipped duplicate persona 'security-paranoide' (resolves to 'security-paranoid')",
    );
  });

  test("collapses exact + fuzzy-duplicate combinations to one entry", () => {
    const out = resolveRequestedPersonas(["security-paranoyd", "security-paranoid"], available);
    expect(out.resolved).toEqual(["security-paranoid"]);
    expect(out.missing).toEqual([]);
  });

  test("unknown persona still surfaces as missing", () => {
    const out = resolveRequestedPersonas(["totally-unrelated"], available);
    expect(out.resolved).toEqual([]);
    expect(out.missing).toEqual(["totally-unrelated"]);
  });

  test("preserves first-seen order across duplicates", () => {
    const out = resolveRequestedPersonas(
      ["performance-hawk", "security-paranoid", "performance-hawk", "ui-pragmatist"],
      available,
    );
    expect(out.resolved).toEqual(["performance-hawk", "security-paranoid", "ui-pragmatist"]);
  });
});

describe("adversarial-review workflow", () => {
  test("fails closed without dispatching when content_path resolves to the binary placeholder", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-binary-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          content_path: "blob.bin",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async () => {
          dispatchCount += 1;
          return {
            conversation_id: `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "",
          "git.show": [],
          "file.contents": {
            path: join(root, "blob.bin"),
            body: "<binary file omitted>",
            truncated: false,
            byte_size: 5,
          },
        },
        warnings: [
          `file.contents: ${join(root, "blob.bin")} 1 NUL bytes escaped`,
          `file.contents: ${join(root, "blob.bin")} binary content omitted`,
          "git.diff: 2 NUL bytes escaped",
        ],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error: string;
        recall_warnings?: string[];
        hint?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("empty_review_target");
      expect(dispatchCount).toBe(0);
      expect(result.hint).toContain("binary");
      expect(result.recall_warnings).toEqual([
        `file.contents: ${join(root, "blob.bin")} 1 NUL bytes escaped`,
        `file.contents: ${join(root, "blob.bin")} binary content omitted`,
        "git.diff: 2 NUL bytes escaped",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not raise the file.contents max_bytes above the source default", () => {
    const fileContents = workflowSpec.recall.find((entry) => entry.source === "file.contents");
    expect(fileContents?.args?.max_bytes).toBeUndefined();
  });

  test("fails closed without dispatching when content_path is binary even if git.diff is non-empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-binary-diff-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          content_path: "blob.bin",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async () => {
          dispatchCount += 1;
          return {
            conversation_id: `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
          "file.contents": {
            path: join(root, "blob.bin"),
            body: "<binary file omitted>",
            truncated: false,
            byte_size: 200000,
          },
        },
        warnings: [`file.contents: ${join(root, "blob.bin")} binary content omitted`],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error: string;
        hint?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("empty_review_target");
      expect(dispatchCount).toBe(0);
      expect(result.hint).toContain("binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed without dispatching when the recall budget trims content_path to a marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-marker-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          content_path: "big.md",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async () => {
          dispatchCount += 1;
          return {
            conversation_id: `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
          "file.contents": {
            path: join(root, "big.md"),
            body: "\n… [recall budget: body truncated to 0 of 180000 chars]",
            truncated: true,
            byte_size: 180000,
          },
        },
        warnings: ["recall budget exceeded: trimmed 1 items (target 24000 tokens)"],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error: string;
        hint?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("empty_review_target");
      expect(dispatchCount).toBe(0);
      expect(result.hint).toContain("budget");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed with allowed-roots hint when content_path is outside allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-roots-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          content_path: "/etc/hosts",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async () => {
          dispatchCount += 1;
          return {
            conversation_id: `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
          "file.contents": {
            path: "/etc/hosts",
            body: null,
            error: "path_outside_allowed_roots",
          },
        },
        warnings: [],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error: string;
        hint?: string;
        file_contents_error?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("empty_review_target");
      expect(dispatchCount).toBe(0);
      expect(result.file_contents_error).toBe("path_outside_allowed_roots");
      expect(result.hint).toContain("allowed roots");
      expect(result.hint).toContain("cwd");
      expect(result.hint).toContain("DAEMON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recall budget warnings reach recall_warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-budget-"));
    try {
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "",
          "git.show": [],
        },
        warnings: ["recall budget exceeded: trimmed 9 items (target 24000 tokens)"],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error: string;
        recall_warnings?: string[];
        hint?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("empty_review_target");
      expect(result.recall_warnings).toContain(
        "recall budget exceeded: trimmed 9 items (target 24000 tokens)",
      );
      expect(result.hint).toContain("budget");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caps git.diff at the source just above the trimmer's post-trim floor", () => {
    const gitDiff = workflowSpec.recall.find((entry) => entry.source === "git.diff");
    // The generic trimmer shrinks ts-carrying git.show commits to
    // sha+subject+marker before touching the no-ts diff; the cap reserves 100
    // tokens per commit (subjects up to ~224 chars are never trimmed) plus the
    // ~15-token file.contents stub, not git.show's untrimmed worst case.
    expect(gitDiff?.args?.max_tokens).toBe(24000 - 20 * 100 - 15);
  });

  test("marks an over-cap git.diff as truncated, names dropped files, and banners the synthesis", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-truncated-"));
    try {
      const writes = new Map<string, string>();
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async (input) => ({
          conversation_id: `conversation-${input.agent}`,
          handoff_id: `handoff-${input.agent}`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "conversation-synth") {
            return {
              status: "completed" as const,
              final_agent: "synth",
              response_text: WELL_FORMED_SYNTHESIS,
            };
          }
          return {
            status: "completed" as const,
            final_agent: "reviewer-agent",
            response_text:
              'Review complete.\n\n```json\n[{"persona":"reviewer","severity":"low","category":"style","file":"a.ts","line":1,"title":"nit","details":"d","suggestion":"s"}]\n```',
          };
        },
        fileWrite: async (path, body) => {
          writes.set(path, body);
          return path;
        },
      });
      const budgetWarning =
        "git.diff: recall budget kept 1 of 3 file sections (240 of 70000 chars); dropped 2: b.ts, c.ts";
      const recall = emptyRecall({
        byKey: {
          "git.diff":
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n… [recall budget: diff truncated to 1 of 3 file sections; dropped: b.ts, c.ts]",
          "git.show": [],
        },
        warnings: [budgetWarning],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        diff_truncated?: boolean;
        diff_dropped_files?: string[];
        recall_warnings?: string[];
      };

      expect(result.ok).toBe(true);
      expect(result.diff_truncated).toBe(true);
      expect(result.diff_dropped_files).toEqual(["b.ts", "c.ts"]);
      expect(result.recall_warnings).toContain(budgetWarning);
      const synthesis = [...writes.entries()].find(([path]) => path.endsWith("synthesis.md"))?.[1];
      expect(synthesis).toBeDefined();
      expect(synthesis).toContain(`> Partial diff: ${budgetWarning}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("content-mode review does not mark a capped incidental git.diff as truncated", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-content-trunc-"));
    try {
      const writes = new Map<string, string>();
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          content_path: "doc.md",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async (input) => ({
          conversation_id: `conversation-${input.agent}`,
          handoff_id: `handoff-${input.agent}`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "conversation-synth") {
            return {
              status: "completed" as const,
              final_agent: "synth",
              response_text: WELL_FORMED_SYNTHESIS,
            };
          }
          return {
            status: "completed" as const,
            final_agent: "reviewer-agent",
            response_text:
              'Review complete.\n\n```json\n[{"persona":"reviewer","severity":"low","category":"style","file":"doc.md","line":1,"title":"nit","details":"d","suggestion":"s"}]\n```',
          };
        },
        fileWrite: async (path, body) => {
          writes.set(path, body);
          return path;
        },
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff":
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n… [recall budget: diff truncated to 1 of 3 file sections; dropped: b.ts, c.ts]",
          "git.show": [],
          "file.contents": {
            path: join(root, "doc.md"),
            body: "Document under review. It proposes a direction worth critiquing.",
            truncated: false,
            byte_size: 66,
          },
        },
        warnings: [
          "git.diff: recall budget kept 1 of 3 file sections (240 of 70000 chars); dropped 2: b.ts, c.ts",
        ],
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        diff_truncated?: boolean;
        diff_dropped_files?: string[];
      };

      expect(result.ok).toBe(true);
      expect(result.diff_truncated).toBeUndefined();
      expect(result.diff_dropped_files).toBeUndefined();
      const synthesis = [...writes.entries()].find(([path]) => path.endsWith("synthesis.md"))?.[1];
      expect(synthesis).toBeDefined();
      expect(synthesis).not.toContain("> Partial diff:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports failure when personas complete but synthesizer dispatch throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-workflow-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: "synth",
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async (input) => {
          dispatchCount += 1;
          if (input.agent === "synth") {
            throw new Error("synth unavailable");
          }
          return {
            conversation_id: `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        awaitChain: async () => ({
          status: "completed" as const,
          final_agent: "reviewer-agent",
          response_text:
            'Review complete.\n\n```json\n[{"persona":"reviewer","severity":"high","category":"correctness","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
        }),
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        synthesizer_status: string | null;
        synth_failed?: boolean;
      };

      expect(result.ok).toBe(false);
      expect(result.synthesizer_status).toBe("failed");
      expect(result.synth_failed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes synthesizer failover banner and frontmatter when a pool member fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-workflow-failover-"));
    try {
      const writes = new Map<string, string>();
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["reviewer"],
              synthesizer: ["bad-synth", "good-synth"],
            },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
          out_dir: "review-out",
        },
        dispatch: async (input) => ({
          conversation_id: `conversation-${input.agent}`,
          handoff_id: `handoff-${input.agent}`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "conversation-bad-synth") {
            return {
              status: "completed",
              final_agent: "bad-synth",
              response_text: "invalid synthesis",
            };
          }
          if (conversationId === "conversation-good-synth") {
            return {
              status: "completed",
              final_agent: "good-synth",
              response_text: [
                "Verdict: land as-is",
                "",
                "## Shared concerns",
                "none - single persona",
                "",
                "## Contradictions",
                "none",
                "",
                "## Severity-ranked findings",
                "none",
                "",
                "## Recommended actions",
                "none",
                "",
                "## Skipped/failed personas",
                "none",
              ].join("\n"),
            };
          }
          return {
            status: "completed",
            final_agent: "reviewer-agent",
            response_text:
              'Review complete.\n\n```json\n[{"persona":"reviewer","severity":"high","category":"correctness","file":"x.ts","line":1,"title":"issue","details":"details","suggestion":"fix"}]\n```',
          };
        },
        fileWrite: async (path, body) => {
          writes.set(path, body);
          return path;
        },
      });

      const result = (await fn(
        ctx,
        emptyRecall({
          byKey: {
            "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
            "git.show": [],
          },
        }),
      )) as {
        ok: boolean;
        synthesizer_status: string | null;
      };

      expect(result.ok).toBe(true);
      expect(result.synthesizer_status).toBe("completed");
      const synthesis = [...writes.entries()].find(([path]) => path.endsWith("synthesis.md"))?.[1];
      expect(synthesis).toContain("> Synthesizer failover: bad-synth -> good-synth");
      expect(synthesis).toContain("synthesizer_failover_from: bad-synth");
      expect(synthesis).toContain("synthesizer_failover_to: good-synth");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits severity metrics from parsed persona findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-metrics-"));
    try {
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["security", "performance"],
              fan_out: 2,
              synthesizer: "codex",
            },
          },
          personas: {
            security: {
              bias: "security",
              system_prompt: "Find security issues.",
              preferred_agent: "security-agent",
            },
            performance: {
              bias: "performance",
              system_prompt: "Find performance issues.",
              preferred_agent: "perf-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
        },
        dispatch: async (input) => ({
          conversation_id: input.agent,
          handoff_id: input.agent,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "codex") {
            return {
              status: "completed" as const,
              final_agent: "codex",
              response_text: WELL_FORMED_SYNTHESIS,
            };
          }
          if (conversationId === "security-agent") {
            return {
              status: "completed" as const,
              final_agent: "security-agent",
              response_text: `review for security\n\n\`\`\`json\n[{"persona":"security","severity":"high","category":"bug","file":"x.ts","line":1,"title":"h1","details":"d","suggestion":"s"},{"persona":"security","severity":"medium","category":"bug","file":"x.ts","line":2,"title":"m1","details":"d","suggestion":"s"}]\n\`\`\``,
            };
          }
          return {
            status: "completed" as const,
            final_agent: "perf-agent",
            response_text: `review for performance\n\n\`\`\`json\n[{"persona":"performance","severity":"low","category":"bug","file":"x.ts","line":1,"title":"l1","details":"d","suggestion":"s"},{"persona":"performance","severity":"info","category":"docs","file":"x.ts","line":2,"title":"i1","details":"d","suggestion":"s"}]\n\`\`\``,
          };
        },
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        high_count: number;
        medium_count: number;
        low_count: number;
        severity_unparsed_personas: number;
      };

      expect(result.ok).toBe(true);
      expect(result.high_count).toBe(1);
      expect(result.medium_count).toBe(1);
      expect(result.low_count).toBe(1);
      expect(result.severity_unparsed_personas).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counts malformed and failed persona findings as unparsed", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-unparsed-"));
    try {
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: {
              eligible_agents: ["security", "performance", "simplicity"],
              fan_out: 3,
              synthesizer: "codex",
            },
          },
          personas: {
            security: {
              bias: "security",
              system_prompt: "Find security issues.",
              preferred_agent: "security-agent",
            },
            performance: {
              bias: "performance",
              system_prompt: "Find performance issues.",
              preferred_agent: "perf-agent",
            },
            simplicity: {
              bias: "simplicity",
              system_prompt: "Find simplicity issues.",
              preferred_agent: "simplicity-agent",
            },
          },
          review_min_personas_pass_pct: 50,
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          target_ref: "HEAD",
          base_ref: "main",
          timeout_ms: 1000,
        },
        dispatch: async (input) => ({
          conversation_id: input.agent,
          handoff_id: input.agent,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "codex") {
            return {
              status: "completed" as const,
              final_agent: "codex",
              response_text: WELL_FORMED_SYNTHESIS,
            };
          }
          if (conversationId === "security-agent") {
            return {
              status: "completed" as const,
              final_agent: "security-agent",
              response_text: `review for security\n\n\`\`\`json\n[{"persona":"security","severity":"high","category":"bug","file":"x.ts","line":1,"title":"h1","details":"d","suggestion":"s"},{"persona":"security","severity":"critical","category":"bug","file":"x.ts","line":2,"title":"c1","details":"d","suggestion":"s"}]\n\`\`\``,
            };
          }
          if (conversationId === "perf-agent") {
            return {
              status: "completed" as const,
              final_agent: "perf-agent",
              response_text: "No findings to report.",
            };
          }
          return {
            status: "completed" as const,
            final_agent: "simplicity-agent",
            response_text: `review for simplicity\n\n\`\`\`json\n[{"persona":"simplicity","severity":"low","category":"bug","file":"x.ts","line":1,"title":"l1","details":"d","suggestion":"s"}]\n\`\`\``,
          };
        },
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
          "git.show": [],
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        high_count: number;
        medium_count: number;
        low_count: number;
        severity_unparsed_personas: number;
      };

      expect(result.ok).toBe(true);
      expect(result.high_count).toBe(1);
      expect(result.medium_count).toBe(0);
      expect(result.low_count).toBe(1);
      expect(result.severity_unparsed_personas).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a timed-out persona exactly once and surfaces cancel_requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-cancel-timeout-"));
    try {
      const cancelled: string[] = [];
      const writes = new Map<string, string>();
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["reviewer"], synthesizer: "synth" },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async (conversationId) =>
          conversationId === "reviewer-agent-conv"
            ? { status: "timeout" as const, final_agent: null, response_text: null }
            : {
                status: "completed" as const,
                final_agent: "synth",
                response_text: WELL_FORMED_SYNTHESIS,
              },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path, body) => {
          writes.set(path, body);
          return path;
        },
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error?: string;
        personas: { name: string; cancel_requested?: boolean; cancel_error?: string }[];
      };

      expect(cancelled).toEqual(["reviewer-agent-conv"]);
      expect(result.error).toBe("all_persona_dispatches_failed");
      expect(result.personas[0]?.name).toBe("reviewer");
      expect(result.personas[0]?.cancel_requested).toBe(true);
      expect(result.personas[0]?.cancel_error).toBeUndefined();
      const personaJson = JSON.parse(
        [...writes.entries()].find(([path]) => path.endsWith("reviewer.json"))?.[1] ?? "{}",
      ) as { status?: string; cancel_requested?: boolean; cancel_error?: string };
      expect(personaJson.status).toBe("timeout");
      expect(personaJson.cancel_requested).toBe(true);
      expect(personaJson.cancel_error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records cancel_error but still resolves when a persona cancel rejects", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-cancel-reject-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["reviewer"], synthesizer: "synth" },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async () => ({
          status: "timeout" as const,
          final_agent: null,
          response_text: null,
        }),
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
          throw new Error("cancel endpoint down");
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        error?: string;
        personas: { name: string; cancel_requested?: boolean; cancel_error?: string }[];
      };

      expect(result.error).toBe("all_persona_dispatches_failed");
      expect(cancelled).toEqual(["reviewer-agent-conv"]);
      expect(result.personas[0]?.cancel_requested).toBe(false);
      expect(result.personas[0]?.cancel_error).toBe("cancel endpoint down");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels the persona chain when awaitChain throws after dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-cancel-throw-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["reviewer"], synthesizer: "synth" },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "reviewer-agent-conv") throw new Error("lost stream");
          return {
            status: "completed" as const,
            final_agent: "synth",
            response_text: WELL_FORMED_SYNTHESIS,
          };
        },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        error?: string;
        personas: { name: string; status: string; cancel_requested?: boolean }[];
      };

      expect(cancelled).toEqual(["reviewer-agent-conv"]);
      expect(result.error).toBe("all_persona_dispatches_failed");
      expect(result.personas[0]?.status).toBe("failed");
      expect(result.personas[0]?.cancel_requested).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels the first persona chain before a worker-unavailable re-dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-cancel-redispatch-"));
    try {
      const cancelled: string[] = [];
      let awaits = 0;
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["reviewer"], synthesizer: "synth" },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv-${cancelled.length}-${awaits}`,
          handoff_id: `${input.agent}-handoff-${awaits}`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId.startsWith("reviewer-agent")) {
            awaits += 1;
            if (awaits === 1) throw new Error("503 no_worker_registered");
            return {
              status: "completed" as const,
              final_agent: "reviewer-agent",
              response_text:
                'review complete\n\n```json\n[{"persona":"reviewer","severity":"high","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
            };
          }
          return {
            status: "completed" as const,
            final_agent: "synth",
            response_text: WELL_FORMED_SYNTHESIS,
          };
        },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        personas: { name: string; status: string; cancel_requested?: boolean }[];
      };

      // First dispatch's await threw a retryable worker-unavailable error: the
      // abandoned chain must be cancelled before the retry dispatch lands.
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toStartWith("reviewer-agent-conv-");
      expect(result.ok).toBe(true);
      expect(result.personas[0]?.status).toBe("completed");
      expect(result.personas[0]?.cancel_requested).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  test("never cancels personas that completed or failed on their own", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-no-cancel-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["a-rev", "b-rev"], synthesizer: "synth" },
          },
          personas: {
            "a-rev": {
              bias: "bias a",
              system_prompt: "Review a.",
              preferred_agent: "a-agent",
            },
            "b-rev": {
              bias: "bias b",
              system_prompt: "Review b.",
              preferred_agent: "b-agent",
            },
          },
          review_min_personas_pass_pct: 50,
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "a-agent-conv") {
            return {
              status: "completed" as const,
              final_agent: "a-agent",
              response_text:
                'review a\n\n```json\n[{"persona":"a","severity":"low","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
            };
          }
          if (conversationId === "b-agent-conv") {
            return { status: "failed" as const, final_agent: "b-agent", response_text: null };
          }
          return {
            status: "completed" as const,
            final_agent: "synth",
            response_text: WELL_FORMED_SYNTHESIS,
          };
        },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        personas: { name: string; status: string; cancel_requested?: boolean }[];
      };

      expect(cancelled).toEqual([]);
      for (const persona of result.personas) {
        expect(persona.cancel_requested).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a timed-out non-pool synthesizer and marks synthesizer_cancel_requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-review-cancel-synth-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
        config: {
          workloads: {
            review_adversarial: { eligible_agents: ["reviewer"], synthesizer: "synth" },
          },
          personas: {
            reviewer: {
              bias: "Find correctness issues",
              system_prompt: "Review the change.",
              preferred_agent: "reviewer-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: { target_ref: "HEAD", base_ref: "main", timeout_ms: 1000, out_dir: "review-out" },
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async (conversationId) => {
          if (conversationId === "synth-conv") {
            return { status: "timeout" as const, final_agent: null, response_text: null };
          }
          return {
            status: "completed" as const,
            final_agent: "reviewer-agent",
            response_text:
              'review done\n\n```json\n[{"persona":"reviewer","severity":"low","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
          };
        },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall({
        byKey: {
          "git.diff": "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        synthesizer_status: string | null;
        synthesizer_cancel_requested?: boolean;
      };

      expect(cancelled).toEqual(["synth-conv"]);
      expect(result.synthesizer_status).toBe("timeout");
      expect(result.synthesizer_cancel_requested).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
