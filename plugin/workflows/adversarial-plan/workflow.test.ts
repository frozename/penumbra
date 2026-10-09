import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Input } from "./workflow.js";

import { emptyRecall, stubScratchWorktree, testWorkflowCtx } from "../_shared/test-helpers.js";
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
              permission_profile: input.permission_profile,
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
            permission_profile: input.permission_profile,
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
            permission_profile: input.permission_profile,
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
          permission_profile: input.permission_profile,
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
          permission_profile: input.permission_profile,
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

describe("permission_profile dispatch contract", () => {
  test("dispatches every planner persona and the synthesizer under review_readonly", async () => {
    const root = mkdtempSync(join(tmpdir(), "penumbra-plan-profile-"));
    try {
      const dispatched: {
        agent: string;
        message: string;
        permission_profile?: string | null;
        max_hops?: number;
      }[] = [];
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
        project: "penumbra",
        args: { topic: "Ship the feature", timeout_ms: 1000 },
        dispatch: async (input) => {
          dispatched.push(input);
          return {
            conversation_id: `${input.agent}-conv`,
            handoff_id: `${input.agent}-handoff`,
            permission_profile: input.permission_profile,
          };
        },
        awaitChain: async (conversationId) =>
          conversationId === "synth-conv"
            ? {
                status: "completed" as const,
                final_agent: "synth",
                response_text: "Merged plan.",
              }
            : {
                status: "completed" as const,
                final_agent: "planner-agent",
                response_text: "Phase 1: write a failing test.",
              },
        fileWrite: async (path) => path,
      });

      const result = (await fn(ctx, emptyRecall())) as { ok: boolean };

      expect(dispatched).toHaveLength(2);
      for (const d of dispatched) {
        expect(d.permission_profile).toBe("review_readonly");
        expect(d.max_hops).toBe(1);
        expect(d.message).toContain("read-only");
      }
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scratch worktree dispatch contract", () => {
  const scratchPath = "/tmp/p6-scratch-plan";

  function planCtx(dispatched: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    return testWorkflowCtx<Input>({
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
      cwd: "/tmp/operator-checkout",
      storageRoot: "/tmp/plan-store",
      project: "penumbra",
      args: { topic: "Plan work", timeout_ms: 1000, out_dir: "plan-out" },
      scratchWorktree: stubScratchWorktree(scratchPath),
      dispatch: async (input) => {
        dispatched.push(input);
        return {
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
          permission_profile: input.permission_profile,
        };
      },
      awaitChain: async (conversationId) =>
        conversationId === "synth-conv"
          ? {
              status: "completed" as const,
              final_agent: "synth",
              response_text: "Merged plan.",
            }
          : {
              status: "completed" as const,
              final_agent: "planner-agent",
              response_text: "Phase 1: write a failing test.",
            },
      fileWrite: async (path) => path,
      ...extra,
    });
  }

  test("every planner persona and the synthesizer dispatch inside the scratch via cwd_override", async () => {
    const dispatched: Record<string, unknown>[] = [];
    const ctx = planCtx(dispatched);

    const result = (await fn(ctx, emptyRecall())) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(dispatched).toHaveLength(2);
    for (const d of dispatched) {
      expect(d.cwd_override).toBe(scratchPath);
      expect(d.use_worktree).toBe(false);
      expect(d.permission_profile).toBe("review_readonly");
      expect(String(d.message)).toContain(`cd ${scratchPath}`);
      expect(String(d.message)).not.toContain("cd /tmp/operator-checkout");
    }
  });

  test("every scratch-bound dispatch carries the scratch's project_id", async () => {
    const dispatched: Record<string, unknown>[] = [];
    const ctx = planCtx(dispatched, {
      scratchWorktree: stubScratchWorktree(scratchPath, { project_id: "proj-uuid-9" }),
    });

    const result = (await fn(ctx, emptyRecall())) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(dispatched).toHaveLength(2);
    for (const d of dispatched) {
      expect(d.project_id).toBe("proj-uuid-9");
    }
  });

  test("the run releases the scratch worktree on success and on dispatch failure", async () => {
    const okStub = stubScratchWorktree(scratchPath);
    await fn(planCtx([], { scratchWorktree: okStub }), emptyRecall());
    expect(okStub.releaseCalls.length).toBe(1);

    const failStub = stubScratchWorktree(scratchPath);
    await fn(
      planCtx([], {
        scratchWorktree: failStub,
        dispatch: async () => {
          throw new Error("daemon down");
        },
        awaitChain: async () => ({
          status: "failed" as const,
          final_agent: null,
          response_text: null,
        }),
      }),
      emptyRecall(),
    );
    expect(failStub.releaseCalls.length).toBe(1);
  });

  test("the scratch is acquired at HEAD — no ref override", async () => {
    const stub = stubScratchWorktree(scratchPath);
    await fn(planCtx([], { scratchWorktree: stub }), emptyRecall());
    expect(stub.acquireCalls).toHaveLength(1);
    expect(stub.acquireCalls[0]?.ref).toBeUndefined();
  });

  test("a ctx without scratchWorktree fails the run as review_worktree_unavailable", async () => {
    const ctx = planCtx([], { scratchWorktree: undefined });
    const result = (await fn(ctx, emptyRecall())) as {
      ok: boolean;
      outcome?: string;
      error?: string;
      detail?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("review_worktree_unavailable");
    expect(result.detail).toBe("ctx_missing_scratch_worktree");
  });

  test("an acquire failure fails the run as review_worktree_unavailable", async () => {
    const ctx = planCtx([], {
      scratchWorktree: { acquire: () => Promise.reject(new Error("repo missing")) },
    });
    const result = (await fn(ctx, emptyRecall())) as {
      ok: boolean;
      outcome?: string;
      error?: string;
      detail?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("review_worktree_unavailable");
    expect(result.detail).toContain("scratch_acquire_failed");
    expect(result.detail).toContain("repo missing");
  });

  test("a persona pinned to a non-enforcing seat fails closed without dispatching it", async () => {
    const dispatched: Record<string, unknown>[] = [];
    const writes: string[] = [];
    const ctx = testWorkflowCtx<Input>({
      config: {
        // planner-agent rides stdio-acp, which cannot natively enforce
        // review_readonly. An explicit pin must throw rather than fall back
        // to a silently-weaker dispatch.
        agents: [
          { name: "planner-agent", roles: ["planner"], adapter: "stdio-acp" },
          { name: "synth", roles: ["planner"], adapter: "openai-compat-http" },
        ],
        workloads: { plan_refine: { eligible_agents: ["planner"], synthesizer: "synth" } },
        personas: {
          planner: {
            bias: "Find gaps",
            system_prompt: "Plan",
            preferred_agent: "planner-agent",
          },
        },
      },
      cwd: "/tmp/operator-checkout",
      storageRoot: "/tmp/plan-store",
      project: "penumbra",
      args: { topic: "Plan work", timeout_ms: 1000, out_dir: "plan-out" },
      scratchWorktree: stubScratchWorktree(scratchPath),
      dispatch: async (input) => {
        dispatched.push(input);
        return {
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
          permission_profile: input.permission_profile,
        };
      },
      fileWrite: async (path, body) => {
        writes.push(body);
        return path;
      },
    });

    const result = (await fn(ctx, emptyRecall())) as {
      ok: boolean;
      error?: string;
      personas?: { name: string; status: string; error_code?: string }[];
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("all_persona_dispatches_failed");
    expect(dispatched).toHaveLength(0);
    expect(result.personas?.[0]?.error_code).toBe("persona_seat_cannot_enforce_profile");
    expect(writes.some((body) => body.includes("persona_seat_cannot_enforce_profile"))).toBe(true);
  });

  test("a two-persona run with one non-enforcing pin still reports success_partial with error_code", async () => {
    const dispatched: Record<string, unknown>[] = [];
    const ctx = testWorkflowCtx<Input>({
      config: {
        agents: [
          { name: "planner-agent", roles: ["planner"], adapter: "stdio-acp" },
          { name: "synth", roles: ["planner"], adapter: "openai-compat-http" },
        ],
        // eligible_agents names persona keys; "planner" is pinned to a
        // non-enforcing stdio-acp seat while "second" pins to an HTTP seat.
        workloads: {
          plan_refine: { eligible_agents: ["planner", "second"], synthesizer: "synth" },
        },
        personas: {
          planner: {
            bias: "Find gaps",
            system_prompt: "Plan",
            preferred_agent: "planner-agent",
          },
          second: {
            bias: "Find more gaps",
            system_prompt: "Plan harder",
            preferred_agent: "synth",
          },
        },
      },
      cwd: "/tmp/operator-checkout",
      storageRoot: "/tmp/plan-store",
      project: "penumbra",
      args: { topic: "Plan work", timeout_ms: 1000, out_dir: "plan-out" },
      scratchWorktree: stubScratchWorktree(scratchPath),
      dispatch: async (input) => {
        dispatched.push(input);
        return {
          conversation_id: `${input.agent}-conv`,
          handoff_id: `${input.agent}-handoff`,
          permission_profile: input.permission_profile,
        };
      },
      awaitChain: async () => ({
        status: "completed" as const,
        final_agent: "synth",
        response_text: "Phase 1: write a failing test.",
      }),
      fileWrite: async (path) => path,
    });

    const result = (await fn(ctx, emptyRecall())) as {
      ok: boolean;
      outcome?: string;
      personas?: { name: string; status: string; error_code?: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success_partial");
    // Only the enforcing-seat persona + the synthesizer actually dispatched.
    expect(dispatched).toHaveLength(2);
    const failed = result.personas?.find((p) => p.status !== "completed");
    expect(failed?.error_code).toBe("persona_seat_cannot_enforce_profile");
    const succeeded = result.personas?.find((p) => p.status === "completed");
    expect(succeeded?.error_code).toBeUndefined();
  });
});
