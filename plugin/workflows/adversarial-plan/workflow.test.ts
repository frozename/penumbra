import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Input } from "./workflow.js";

import { emptyRecall, testWorkflowCtx } from "../_shared/test-helpers.js";
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
  for (const waitThrows of [false, true]) {
    for (const cancelThrows of [false, true]) {
      test(`records synthesizer cancel outcome for ${waitThrows ? "thrown wait" : "timeout"} and ${cancelThrows ? "failed" : "successful"} cancel`, async () => {
        const root = mkdtempSync(join(tmpdir(), "penumbra-plan-cancel-record-"));
        try {
          const ctx = testWorkflowCtx<Input>({
            config: {
              workloads: { plan_refine: { eligible_agents: ["planner"], synthesizer: "synth" } },
              personas: {
                planner: {
                  bias: "Find gaps",
                  system_prompt: "Plan",
                  preferred_agent: "planner-agent",
                },
              },
            },
            cwd: root,
            storageRoot: root,
            args: { topic: "Plan work", timeout_ms: 1000, out_dir: "plan-out" },
            dispatch: async (input) => ({
              conversation_id: `${input.agent}-conv`,
              handoff_id: `${input.agent}-handoff`,
            }),
            awaitChain: async (conversationId) => {
              if (conversationId !== "synth-conv")
                return {
                  status: "completed",
                  final_agent: "planner-agent",
                  response_text: "Plan the work.",
                };
              if (waitThrows) throw new Error("wait failed");
              return { status: "timeout", final_agent: null, response_text: null };
            },
            cancel: async () => {
              if (cancelThrows) throw new Error("cancel down");
            },
          });
          const result = (await fn(ctx, emptyRecall())) as {
            synthesizer_cancel_requested?: boolean;
            synthesizer_cancel_error?: string;
          };
          expect(result.synthesizer_cancel_requested).toBe(!cancelThrows);
          expect(result.synthesizer_cancel_error).toBe(cancelThrows ? "cancel down" : undefined);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
  test("reports failure when personas complete but synthesizer dispatch throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-workflow-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
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
          final_agent: "planner-agent",
          response_text: "Phase 1: write a failing test. Phase 2: implement the fix.",
        }),
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall();

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

  test("reports failure when personas complete but synthesizer times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-workflow-"));
    try {
      let dispatchCount = 0;
      const ctx = testWorkflowCtx<Input>({
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
        dispatch: async (input) => {
          dispatchCount += 1;
          return {
            conversation_id:
              input.agent === "synth" ? "synth-conversation" : `conversation-${dispatchCount}`,
            handoff_id: `handoff-${dispatchCount}`,
          };
        },
        awaitChain: async (conversationId) =>
          conversationId === "synth-conversation"
            ? {
                status: "timeout" as const,
                final_agent: null,
                response_text: null,
              }
            : {
                status: "completed" as const,
                final_agent: "planner-agent",
                response_text: "Phase 1: write a failing test. Phase 2: implement the fix.",
              },
        fileWrite: async (path) => path,
      });
      const recall = emptyRecall();

      const result = (await fn(ctx, recall)) as {
        ok: boolean;
        outcome: string;
        synthesizer_status: string | null;
        synth_failed?: boolean;
        failed_personas: string[];
      };

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("success");
      expect(result.failed_personas).toEqual([]);
      expect(result.synthesizer_status).toBe("timeout");
      expect(result.synth_failed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a timed-out persona chain with its conversation_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-cancel-persona-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
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
        },
        fileWrite: async (path) => path,
      });

      const result = (await fn(ctx, emptyRecall())) as {
        error?: string;
        personas: { name: string; status: string; cancel_requested?: boolean }[];
      };

      expect(cancelled).toEqual(["planner-agent-conv"]);
      expect(result.error).toBe("all_persona_dispatches_failed");
      expect(result.personas[0]?.status).toBe("timeout");
      expect(result.personas[0]?.cancel_requested).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a timed-out synthesizer chain with its conversation_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-cancel-synth-"));
    try {
      const cancelled: string[] = [];
      const ctx = testWorkflowCtx<Input>({
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
        dispatch: async (input) => ({
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
        }),
        awaitChain: async (conversationId) =>
          conversationId === "synth-conv"
            ? { status: "timeout" as const, final_agent: null, response_text: null }
            : {
                status: "completed" as const,
                final_agent: "planner-agent",
                response_text: "Phase 1: write a failing test. Phase 2: implement the fix.",
              },
        cancel: async (conversationId) => {
          cancelled.push(conversationId);
        },
        fileWrite: async (path) => path,
      });

      const result = (await fn(ctx, emptyRecall())) as {
        synthesizer_status: string | null;
        synth_failed?: boolean;
      };

      expect(cancelled).toEqual(["synth-conv"]);
      expect(result.synthesizer_status).toBe("timeout");
      expect(result.synth_failed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
