import { describe, expect, test } from "bun:test";

import type { AgentConfig, AgentsConfig } from "../../src/files/agents.js";
import type { ModelAliasMap } from "../../src/files/model-aliases.js";

import {
  type GeneratorSafetyGateContext,
  runGeneratorSafetyGate,
} from "../../src/generator/safety-gate.js";

function agent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return {
    adapter: "stdio-acp",
    options: {},
    roles: [],
    auto_approve_to: [],
    pricing_mode: "api",
    ...overrides,
  };
}

// Mirrors role-floors.test.ts's completeAgents(): one holder per consumed role
// tag, dreaming-judge covered twice by lineage-diverse agents so the floor
// assertion passes outright.
function completeAgents(): AgentConfig[] {
  return [
    agent({ name: "rewriter-seat", roles: ["dreaming-rewriter"] }),
    agent({ name: "brief-seat", roles: ["brief-synthesizer"] }),
    agent({ name: "judge-seat-a", roles: ["dreaming-judge"] }),
    agent({ name: "judge-seat-b", roles: ["dreaming-judge"] }),
    agent({ name: "memory-refiner-seat", roles: ["memory-refiner"] }),
    agent({ name: "refiner-seat", roles: ["refiner"] }),
  ];
}

function diverseAliasMap(): ModelAliasMap {
  return {
    "judge-seat-a": { aa_creator: "anthropic", aa_slug: "claude-sonnet-4-5" },
    "judge-seat-b": { aa_creator: "openai", aa_slug: "gpt-5.6" },
  };
}

function baseCtx(): GeneratorSafetyGateContext {
  return {
    allowedProviders: ["local", "sakana"],
    aliasMap: diverseAliasMap(),
    roleTags: ["executor", "reviewer"],
    seatNameInputs: [],
    candidatePrunes: [],
    routing: { default_roles: {} },
  };
}

describe("runGeneratorSafetyGate", () => {
  test("aggregates every failing assertion into one report rather than stopping at the first", () => {
    const agents: AgentConfig[] = [
      // Drop the refiner holder -> role-floor violation.
      ...completeAgents().filter((a) => !a.roles.includes("refiner")),
      // Billed http seat outside the allowlist -> billed-HTTP violation.
      agent({
        name: "openai-gpt-http",
        adapter: "openai-compat-http",
        pricing_mode: "api",
        api_provider: "openai",
      }),
    ];
    const candidateConfig: AgentsConfig = { agents };

    const result = runGeneratorSafetyGate(candidateConfig, baseCtx());

    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => /openai-gpt-http/.test(v))).toBe(true);
    expect(result.violations.some((v) => /refiner/.test(v))).toBe(true);
  });

  test("ok:true with no violations lets the caller proceed to write", () => {
    const candidateConfig: AgentsConfig = { agents: completeAgents() };

    const result = runGeneratorSafetyGate(candidateConfig, baseCtx());

    expect(result).toEqual({ ok: true, violations: [] });
  });
});
