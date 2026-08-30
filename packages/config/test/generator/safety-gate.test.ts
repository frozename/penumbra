import type { AgentConfig, AgentsConfig } from "@src/files/agents.js";
import type { ModelAliasMap } from "@src/files/model-aliases.js";

import {
  type GeneratorSafetyGateContext,
  runGeneratorSafetyGate,
} from "@src/generator/safety-gate.js";
import { describe, expect, test } from "bun:test";

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
    generatorSource: "providers-sync",
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
    expect(result.violations.some((v) => v.includes("openai-gpt-http"))).toBe(true);
    expect(result.violations.some((v) => v.includes("refiner"))).toBe(true);
  });

  test("reports a generator-owned billed stdio-acp seat alongside the existing HTTP tripwire", () => {
    const candidateConfig: AgentsConfig = {
      agents: [
        ...completeAgents(),
        agent({
          name: "openai-gpt-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "openai",
          provenance: { source: "providers-sync" },
        }),
        agent({
          name: "openai-gpt-stdio",
          adapter: "stdio-acp",
          pricing_mode: "api",
          api_provider: "openai",
          provenance: { source: "providers-sync" },
        }),
      ],
    };

    const result = runGeneratorSafetyGate(candidateConfig, {
      ...baseCtx(),
      generatorSource: "providers-sync",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.some((violation) => violation.includes("openai-gpt-http"))).toBe(true);
    expect(result.violations.some((violation) => violation.includes("openai-gpt-stdio"))).toBe(
      true,
    );
  });

  test("ok:true with no violations lets the caller proceed to write", () => {
    const candidateConfig: AgentsConfig = { agents: completeAgents() };

    const result = runGeneratorSafetyGate(candidateConfig, baseCtx());

    expect(result).toEqual({ ok: true, violations: [], warnings: [] });
  });

  test("warns without failing when a hand-authored seat name equals a live role tag", () => {
    const candidateConfig: AgentsConfig = {
      agents: [...completeAgents(), agent({ name: "executor" })],
    };

    const result = runGeneratorSafetyGate(candidateConfig, baseCtx());

    expect(result).toEqual({
      ok: true,
      violations: [],
      warnings: [
        "pre-existing seat name(s) equal live role tag(s) (exact-name dispatch will silently role-route): executor",
      ],
    });
  });

  test("fails when a generated seat name equals a live role tag", () => {
    const generatedName = "openai-gpt-5";
    const candidateConfig: AgentsConfig = {
      agents: [...completeAgents(), agent({ name: generatedName })],
    };

    const result = runGeneratorSafetyGate(candidateConfig, {
      ...baseCtx(),
      roleTags: [generatedName],
      seatNameInputs: [{ source: "openai", modelSlug: "gpt-5" }],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      "generated seat name(s) collide with live role tag(s), which would silently role-route an exact-name dispatch instead of hitting the named seat: openai-gpt-5",
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("retains collision findings and warnings when another generated name input is invalid", () => {
    const generatedName = "openai-gpt-5";
    const candidateConfig: AgentsConfig = {
      agents: [...completeAgents(), agent({ name: generatedName }), agent({ name: "executor" })],
    };

    const result = runGeneratorSafetyGate(candidateConfig, {
      ...baseCtx(),
      roleTags: [generatedName, "executor"],
      seatNameInputs: [
        { source: "openai", modelSlug: "gpt-5" },
        { source: "---", modelSlug: "..." },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.includes(generatedName))).toBe(true);
    expect(
      result.violations.some((violation) => violation.includes("normalizes to an empty")),
    ).toBe(true);
    expect(result.warnings).toEqual([
      "pre-existing seat name(s) equal live role tag(s) (exact-name dispatch will silently role-route): executor",
    ]);
  });
});
