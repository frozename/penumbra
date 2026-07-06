import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallBundle, WorkflowCtx } from "../../../packages/workflows/src/index.js";
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
      const ctx = {
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
        dispatch: async (input: { agent: string }) => {
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
        fileWrite: async (path: string) => path,
      } satisfies Partial<WorkflowCtx>;
      const recall = {
        byKey: { "git.diff": "", "git.show": [] },
        warnings: [],
        estimatedTokens: 0,
      } satisfies RecallBundle;

      const result = (await fn(ctx as WorkflowCtx, recall)) as {
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
});
