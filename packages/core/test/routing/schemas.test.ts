import { describe, expect, test } from "bun:test";

import {
  AaModelSchema,
  AaModelSnapshotSchema,
  HarnessContextSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type TaskProfile,
  TaskProfileSchema,
} from "@src/routing/schemas.js";

import aaLiveSample from "./fixtures/aa-live-sample.json";

function validTaskProfile(): TaskProfile {
  return {
    schemaVersion: "1",
    taskTypes: ["coding", "debugging"],
    complexity: 0.4,
    risk: 0.3,
    ambiguity: 0.2,
    codingDemand: 0.8,
    reasoningDemand: 0.7,
    agenticDemand: 0.5,
    contextDemand: 0.6,
    latencySensitivity: 0.1,
    costSensitivity: 0.2,
    reliabilityDemand: 0.9,
    expectedInputTokens: 1200,
    expectedOutputTokens: 700,
    requiredCapabilities: ["typescript"],
    preferredCapabilities: ["zod"],
    disallowedCapabilities: ["no-tools"],
    confidence: 0.85,
    rationale: ["Needs schema-level validation."],
  };
}

function validRoutingDecision(): RoutingDecision {
  return {
    selected: {
      agent: "codex-acp-fast",
      provider: "openai",
      reasoningLevel: "medium",
      routeId: "openai:codex-acp-fast",
    },
    taskProfile: validTaskProfile(),
    score: 0.88,
    confidence: 0.8,
    alternatives: [
      {
        routeId: "anthropic:claude-acp-sonnet",
        score: 0.72,
        excluded: false,
        reasons: ["Lower coding score."],
      },
    ],
    factors: [
      {
        name: "coding",
        rawValue: 0.81,
        normalizedValue: 0.81,
        weight: 0.4,
        contribution: 0.324,
        source: "artificial_analysis",
      },
      {
        name: "quota",
        source: "harness",
      },
    ],
    fallbackChain: ["claude-acp-sonnet"],
    dataFreshness: {
      artificial_analysis: "2026-08-23T00:00:00.000Z",
    },
    explanation: ["Selected highest scoring available agent."],
    routerSchemaVersion: "1",
  };
}

describe("routing domain schemas", () => {
  test("TaskProfileSchema rejects a payload missing schemaVersion", () => {
    const { schemaVersion: _schemaVersion, ...payload } = validTaskProfile();

    expect(TaskProfileSchema.safeParse(payload).success).toBe(false);
  });

  test("rejects complexity outside [0,1]", () => {
    expect(
      TaskProfileSchema.safeParse({
        ...validTaskProfile(),
        complexity: 1.1,
      }).success,
    ).toBe(false);
  });

  test("rejects complexity below 0", () => {
    expect(
      TaskProfileSchema.safeParse({
        ...validTaskProfile(),
        complexity: -0.1,
      }).success,
    ).toBe(false);
  });

  test("TaskProfileSchema rejects an unknown key", () => {
    expect(
      TaskProfileSchema.safeParse({
        ...validTaskProfile(),
        injectedDirective: "x",
      }).success,
    ).toBe(false);
  });

  test("RoutingDecisionSchema rejects an unknown key", () => {
    expect(
      RoutingDecisionSchema.safeParse({
        ...validRoutingDecision(),
        injectedDirective: "x",
      }).success,
    ).toBe(false);
  });

  test("RoutingDecisionSchema rejects unknown nested object keys", () => {
    const valid = validRoutingDecision();
    if (!valid.selected) throw new Error("fixture must select an agent");
    expect(
      RoutingDecisionSchema.safeParse({
        ...valid,
        selected: {
          ...valid.selected,
          injectedDirective: "x",
        },
      }).success,
    ).toBe(false);
    expect(
      RoutingDecisionSchema.safeParse({
        ...validRoutingDecision(),
        alternatives: [
          {
            ...validRoutingDecision().alternatives[0],
            injectedDirective: "x",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RoutingDecisionSchema.safeParse({
        ...validRoutingDecision(),
        factors: [
          {
            ...validRoutingDecision().factors[0],
            injectedDirective: "x",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("HarnessContextSchema rejects an unknown key", () => {
    expect(
      HarnessContextSchema.safeParse({
        availableAgents: ["codex-acp-fast"],
        injectedDirective: "x",
      }).success,
    ).toBe(false);
  });

  test("HarnessContextSchema rejects unknown nested object keys", () => {
    expect(
      HarnessContextSchema.safeParse({
        subscriptionQuota: {
          remainingPct: 0.5,
          injectedDirective: "x",
        },
      }).success,
    ).toBe(false);
    expect(
      HarnessContextSchema.safeParse({
        marginalCashCostUsd: {
          totalUsd: 0.01,
          injectedDirective: "x",
        },
      }).success,
    ).toBe(false);
  });

  test("factors[].rawValue accepts a string raw value", () => {
    expect(
      RoutingDecisionSchema.safeParse({
        ...validRoutingDecision(),
        factors: [
          {
            name: "quota",
            rawValue: "stale",
            source: "harness",
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("RoutingDecisionSchema requires factors[].source to be one of artificial_analysis|harness|local_history|config", () => {
    expect(
      RoutingDecisionSchema.safeParse({
        ...validRoutingDecision(),
        factors: [
          {
            name: "bad-source",
            source: "operator_guess",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("HarnessContextSchema parse({}) leaves every optional field undefined, never 0 or false", () => {
    const parsed = HarnessContextSchema.parse({});

    expect(Object.hasOwn(parsed, "availableAgents")).toBe(false);
    expect(parsed.availableAgents).toBeUndefined();
    expect(parsed.promptChars).toBeUndefined();
    expect(parsed.estimatedInputTokens).toBeUndefined();
    expect(parsed.estimatedOutputTokens).toBeUndefined();
    expect(parsed.taskClass).toBeUndefined();
    expect(parsed.projectId).toBeUndefined();
    expect(parsed.dispatchKind).toBeUndefined();
    expect(parsed.role).toBeUndefined();
    expect(parsed.localOnly).toBeUndefined();
    expect(parsed.subscriptionQuota).toBeUndefined();
    expect(parsed.marginalCashCostUsd).toBeUndefined();
  });

  test("RoutingDecisionSchema round-trips byte-identically through JSON.stringify/parse", () => {
    const parsed = RoutingDecisionSchema.parse(validRoutingDecision());
    const serialized = JSON.stringify(parsed);

    expect(JSON.stringify(RoutingDecisionSchema.parse(JSON.parse(serialized)))).toBe(serialized);
  });

  test("AaModelSnapshotSchema accepts a response with tier-gated fields absent, marking them absent rather than zero", () => {
    const parsed = AaModelSnapshotSchema.parse({
      collectedAt: "2026-08-23T00:00:00.000Z",
      models: [
        {
          id: "aa:model:1",
          name: "Model 1",
          slug: "model-1",
          model_creator: {
            id: "creator:1",
            name: "Creator",
            slug: "creator",
          },
          evaluations: {
            artificial_analysis_intelligence_index: 78,
          },
          pricing: {},
        },
      ],
    });

    expect(parsed.models[0].evaluations.artificial_analysis_coding_index).toBeUndefined();
    expect(Object.hasOwn(parsed.models[0].evaluations, "artificial_analysis_coding_index")).toBe(
      false,
    );
    expect(parsed.models[0].pricing.price_1m_input_tokens).toBeUndefined();
    expect(Object.hasOwn(parsed.models[0].pricing, "price_1m_input_tokens")).toBe(false);
  });

  test("AaModelSchema tolerates an unknown extra field", () => {
    const parsed = AaModelSchema.parse({
      id: "aa:model:1",
      name: "Model 1",
      slug: "model-1",
      model_creator: {
        id: "creator:1",
        name: "Creator",
        slug: "creator",
      },
      evaluations: {},
      pricing: {},
      upstreamExtraField: "additive",
    });

    expect(parsed.id).toBe("aa:model:1");
  });

  test("live-capture fixture round-trips with all tier fields preserved", () => {
    const parsed = AaModelSnapshotSchema.parse({
      collectedAt: "2026-08-25T00:00:00.000Z",
      models: aaLiveSample.data,
    });

    expect(parsed.models[0].evaluations.terminalbench_hard).toBe(0.659090909090909);
    expect(parsed.models[0].evaluations.tau2).toBe(0.850877192982456);
    expect(parsed.models[0].evaluations.ifbench).toBe(0.726530612244898);
    expect(parsed.models[0].evaluations.lcr).toBe(0.776666666666667);
    expect(parsed.models[0].release_date).toBe("2026-07-09");
    expect(Object.hasOwn(parsed.models[0].evaluations, "aime_25")).toBe(true);
    expect(parsed.models[0].evaluations.aime_25).toBeNull();
  });
});
