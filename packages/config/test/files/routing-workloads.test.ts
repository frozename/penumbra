import { describe, expect, test } from "bun:test";

import { RoutingConfigSchema } from "../../src/files/routing.js";

describe("RoutingConfigSchema workloads", () => {
  test("accepts closed workload enum keys and expected entry shape", () => {
    const parsed = RoutingConfigSchema.parse({
      default_roles: {},
      workloads: {
        plan_refine: { eligible_roles: ["planner"], synthesizer: "claude-acp-sonnet" },
        implement_small: { eligible_roles: ["executor"], fan_out: 1 },
        implement_substantial: {
          eligible_roles: ["executor", "reviewer"],
          eligible_agents: ["codex-acp-deep", "gemini-acp-pro"],
          fan_out: 2,
          synthesizer: "claude-acp-sonnet",
        },
        review_adversarial: { eligible_roles: ["reviewer"], fan_out: 3 },
        docs_mechanical: { eligible_roles: ["executor"] },
        debug_diagnose: { eligible_roles: ["executor", "reviewer"] },
        smoke_test: { eligible_roles: ["executor"] },
        health_check: { eligible_roles: ["executor"] },
        unknown: { eligible_roles: ["executor"] },
      },
    });

    expect(Object.keys(parsed.workloads ?? {}).sort()).toEqual([
      "debug_diagnose",
      "docs_mechanical",
      "health_check",
      "implement_small",
      "implement_substantial",
      "plan_refine",
      "review_adversarial",
      "smoke_test",
      "unknown",
    ]);
  });

  test("rejects unknown workload keys", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        workloads: {
          not_a_workload: { eligible_roles: ["executor"] },
        },
      }),
    ).toThrow(/not_a_workload/);
  });

  test("rejects legacy persona keys at top level", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        review_personas: {
          architect: {
            name: "architect",
            bias: "balanced",
            system_prompt: "prompt",
            preferred_agent: "codex",
          },
        },
      }),
    ).toThrow(/review_personas/);
  });

  test("rejects unknown keys within a workload entry", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        workloads: {
          plan_refine: {
            eligible_roles: ["planner"],
            extra: true,
          },
        },
      }),
    ).toThrow(/extra/);
  });

  test("accepts workload synthesizer pools without coercing strings", () => {
    const arrayParsed = RoutingConfigSchema.parse({
      default_roles: {},
      workloads: {
        plan_refine: {
          eligible_roles: ["planner"],
          synthesizer: ["claude-acp-sonnet", "codex-acp-deep"],
        },
      },
    });
    expect(arrayParsed.workloads?.plan_refine?.synthesizer).toEqual([
      "claude-acp-sonnet",
      "codex-acp-deep",
    ]);

    const stringParsed = RoutingConfigSchema.parse({
      default_roles: {},
      workloads: {
        plan_refine: {
          eligible_roles: ["planner"],
          synthesizer: "claude-acp-sonnet",
        },
      },
    });
    expect(stringParsed.workloads?.plan_refine?.synthesizer).toBe("claude-acp-sonnet");
  });

  test("rejects empty and non-string workload synthesizers but keeps it optional", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        workloads: {
          plan_refine: {
            eligible_roles: ["planner"],
            synthesizer: [],
          },
        },
      }),
    ).toThrow();

    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        workloads: {
          plan_refine: {
            eligible_roles: ["planner"],
            synthesizer: 42,
          },
        },
      }),
    ).toThrow();

    const parsed = RoutingConfigSchema.parse({
      default_roles: {},
      workloads: {
        plan_refine: {
          eligible_roles: ["planner"],
        },
      },
    });
    expect(parsed.workloads?.plan_refine?.synthesizer).toBeUndefined();
  });
});
