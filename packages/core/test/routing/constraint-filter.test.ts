import { describe, expect, test } from "bun:test";

import { applyHardConstraints } from "../../src/routing/constraint-filter.js";

function taskProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1" as const,
    taskTypes: ["coding" as const],
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
    expectedInputTokens: 1_200,
    expectedOutputTokens: 700,
    requiredCapabilities: [],
    preferredCapabilities: [],
    disallowedCapabilities: [],
    confidence: 0.85,
    rationale: ["Constraint-filter test fixture."],
    ...overrides,
  };
}

describe("applyHardConstraints", () => {
  test("a privacy/local-only constraint excludes every remote candidate and never re-admits, even when that empties the pool", () => {
    const result = applyHardConstraints(
      ["remote-a", "remote-b"],
      taskProfile(),
      { localOnly: true },
      {
        "remote-a": { isRemote: true },
        "remote-b": { isRemote: true },
      },
      {},
    );

    // Hard constraints must not re-admit an empty pool.
    expect(result.admitted).toEqual([]);
    expect(result.excluded).toEqual([
      { agent: "remote-a", reasons: ["privacy_local_only"] },
      { agent: "remote-b", reasons: ["privacy_local_only"] },
    ]);
  });

  test("local-only excludes a candidate with unknown remoteness, with a distinct reason", () => {
    const result = applyHardConstraints(
      ["unknown-remoteness"],
      taskProfile(),
      { localOnly: true },
      { "unknown-remoteness": {} },
      {},
    );

    expect(result).toEqual({
      admitted: [],
      excluded: [
        {
          agent: "unknown-remoteness",
          reasons: ["privacy_local_only_unknown_remoteness"],
        },
      ],
    });
  });

  test("local-only admits a candidate known to be local (isRemote false)", () => {
    const result = applyHardConstraints(
      ["local"],
      taskProfile(),
      { localOnly: true },
      { local: { isRemote: false } },
      {},
    );

    expect(result).toEqual({ admitted: ["local"], excluded: [] });
  });

  test("without localOnly, unknown remoteness admits as before", () => {
    const result = applyHardConstraints(
      ["unknown-remoteness"],
      taskProfile(),
      {},
      { "unknown-remoteness": {} },
      {},
    );

    expect(result).toEqual({ admitted: ["unknown-remoteness"], excluded: [] });
  });

  test("applies each known non-context hard constraint with its stable reason", () => {
    const cases = [
      {
        name: "unhealthy/unavailable",
        facts: { alpha: { healthy: false } },
        profile: taskProfile(),
        harness: {},
        config: {},
        reason: "unhealthy_or_unavailable",
      },
      {
        name: "missing required capability or modality",
        facts: { alpha: { capabilities: ["typescript"] } },
        profile: taskProfile({ requiredCapabilities: ["vision"] }),
        harness: {},
        config: {},
        reason: "missing_required_capability_or_modality",
      },
      {
        name: "exhausted quota",
        facts: { alpha: { quotaExhausted: true } },
        profile: taskProfile(),
        harness: {},
        config: {},
        reason: "quota_exhausted",
      },
      {
        name: "denied by config",
        facts: { alpha: { deniedByConfig: true } },
        profile: taskProfile(),
        harness: {},
        config: {},
        reason: "denied_by_config",
      },
    ];

    for (const scenario of cases) {
      const result = applyHardConstraints(
        ["alpha"],
        scenario.profile,
        scenario.harness,
        scenario.facts,
        scenario.config,
      );

      expect(result, scenario.name).toEqual({
        admitted: [],
        excluded: [{ agent: "alpha", reasons: [scenario.reason] }],
      });
    }
  });

  test("a candidate whose context window is below expectedInput + expectedOutput + safety margin is excluded with reason 'context_fit'", () => {
    const result = applyHardConstraints(
      ["too-small"],
      taskProfile(),
      {},
      { "too-small": { contextWindowTokens: 1_999 } },
      { context_safety_margin_tokens: 100 },
    );

    expect(result).toEqual({
      admitted: [],
      excluded: [{ agent: "too-small", reasons: ["context_fit"] }],
    });
  });

  test("a known input alone exceeding the window excludes with context_fit even when the output estimate is unknown", () => {
    const result = applyHardConstraints(
      ["too-small"],
      taskProfile({ expectedOutputTokens: undefined }),
      {},
      { "too-small": { contextWindowTokens: 1_250 } },
      { context_safety_margin_tokens: 100 },
    );

    expect(result).toEqual({
      admitted: [],
      excluded: [{ agent: "too-small", reasons: ["context_fit"] }],
    });
  });

  test("a known input fitting the window with unknown output admits (no fabricated output estimate)", () => {
    const result = applyHardConstraints(
      ["fits"],
      taskProfile({ expectedOutputTokens: undefined }),
      {},
      { fits: { contextWindowTokens: 1_400 } },
      { context_safety_margin_tokens: 100 },
    );

    expect(result).toEqual({ admitted: ["fits"], excluded: [] });
  });

  test("the context check no-ops when the candidate has no known context window, never fabricating one", () => {
    const result = applyHardConstraints(
      ["unknown-window"],
      taskProfile(),
      {},
      { "unknown-window": {} },
      { context_safety_margin_tokens: 100 },
    );

    expect(result).toEqual({ admitted: ["unknown-window"], excluded: [] });
  });

  test("an unknown predicted cost passes the budget constraint — unknown is neither zero nor an exclusion", () => {
    const facts = { "unknown-cost": { predictedCostUsd: undefined } };
    const result = applyHardConstraints(["unknown-cost"], taskProfile(), {}, facts, {
      max_predicted_cost_usd_per_dispatch: 0.01,
    });

    expect(facts["unknown-cost"].predictedCostUsd).toBeUndefined();
    expect(result).toEqual({ admitted: ["unknown-cost"], excluded: [] });
  });

  test("a known predicted cost above max_predicted_cost_usd_per_dispatch is excluded", () => {
    const result = applyHardConstraints(
      ["over-budget"],
      taskProfile(),
      {},
      { "over-budget": { predictedCostUsd: 0.011 } },
      { max_predicted_cost_usd_per_dispatch: 0.01 },
    );

    expect(result).toEqual({
      admitted: [],
      excluded: [{ agent: "over-budget", reasons: ["hard_budget"] }],
    });
  });

  test("a deniedByConfig candidate is excluded because denial is enumerated, while absence means not denied", () => {
    const result = applyHardConstraints(
      ["denied", "allowed"],
      taskProfile(),
      {},
      { denied: { deniedByConfig: true }, allowed: {} },
      {},
    );

    expect(result).toEqual({
      admitted: ["allowed"],
      excluded: [{ agent: "denied", reasons: ["denied_by_config"] }],
    });
  });

  test("every excluded candidate carries a non-empty reason list, and a candidate can accumulate multiple reasons", () => {
    const result = applyHardConstraints(
      ["blocked"],
      taskProfile({ requiredCapabilities: ["vision"] }),
      { localOnly: true },
      {
        blocked: {
          healthy: false,
          capabilities: [],
          isRemote: true,
          predictedCostUsd: 2,
          quotaExhausted: true,
          deniedByConfig: true,
        },
      },
      { max_predicted_cost_usd_per_dispatch: 0.01 },
    );

    expect(result.admitted).toEqual([]);
    expect(result.excluded).toEqual([
      {
        agent: "blocked",
        reasons: [
          "unhealthy_or_unavailable",
          "missing_required_capability_or_modality",
          "privacy_local_only",
          "hard_budget",
          "quota_exhausted",
          "denied_by_config",
        ],
      },
    ]);
    expect(result.excluded.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  test("admitted preserves input candidate order", () => {
    const result = applyHardConstraints(
      ["gamma", "alpha", "beta"],
      taskProfile(),
      {},
      {
        gamma: { healthy: true },
        alpha: {},
        beta: { capabilities: ["typescript"] },
      },
      {},
    );

    expect(result).toEqual({ admitted: ["gamma", "alpha", "beta"], excluded: [] });
  });
});
