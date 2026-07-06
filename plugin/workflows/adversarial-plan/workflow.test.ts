import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallBundle, WorkflowCtx } from "../../../packages/workflows/src/index.js";
import { dedupePersonas, fn } from "./workflow.js";

describe("dedupePersonas", () => {
  test("returns an empty array unchanged", () => {
    expect(dedupePersonas([])).toEqual([]);
  });

  test("returns unique names unchanged in declaration order", () => {
    expect(dedupePersonas(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("collapses adjacent duplicates and preserves order", () => {
    expect(dedupePersonas(["a", "a", "b"])).toEqual(["a", "b"]);
  });

  test("collapses non-adjacent duplicates and preserves first-seen order", () => {
    expect(dedupePersonas(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("collapses all-identical input to a single entry", () => {
    expect(dedupePersonas(["a", "a", "a", "a"])).toEqual(["a"]);
  });

  test("treats names as case-sensitive distinct values", () => {
    expect(dedupePersonas(["a", "A", "a"])).toEqual(["a", "A"]);
  });
});

describe("adversarial-plan workflow", () => {
  test("reports failure when personas complete but synthesizer dispatch throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-workflow-"));
    try {
      let dispatchCount = 0;
      const ctx = {
        config: {
          workloads: {
            plan_refine: {
              eligible_agents: ["planner"],
              synthesizer: "synth",
            },
          },
          personas: {
            planner: {
              bias: "Find planning gaps",
              system_prompt: "Plan the work.",
              preferred_agent: "planner-agent",
            },
          },
        },
        cwd: root,
        storageRoot: root,
        project: "penumbra",
        args: {
          topic: "Fix the workflow status",
          timeout_ms: 1000,
          out_dir: "plan-out",
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
          final_agent: "planner-agent",
          response_text: "Phase 1: write a failing test. Phase 2: implement the fix.",
        }),
        fileWrite: async (path: string) => path,
      } satisfies Partial<WorkflowCtx>;
      const recall = {
        byKey: {},
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
