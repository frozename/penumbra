import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Input } from "./workflow.js";

import { emptyRecall, testWorkflowCtx } from "../_shared/test-helpers.js";
import { fn, resolveRequestedPersonas } from "./workflow.js";

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
});
