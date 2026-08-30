import type { ModelAliasMap, TaskRouterConfig } from "@penumbra/config";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import {
  applyHardConstraints,
  type CandidateConstraintFacts,
} from "@src/routing/constraint-filter.js";
import {
  computePriors,
  decide,
  type DecideInput,
  reconciliationFactorFields,
  type RouterDependencies,
} from "@src/routing/router.js";
import {
  type AaModel,
  type AaModelSnapshot,
  AaModelSnapshotSchema,
  RoutingDecisionSchema,
  type TaskProfile,
} from "@src/routing/schemas.js";
import { routeAgent } from "@src/services/agent-routing.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

import aaLiveSample from "./fixtures/aa-live-sample.json";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const NOW = new Date("2026-08-25T12:00:00.000Z");
const ROLE = "executor";
const REGISTRY = ["quality-seat", "fast-seat"];
let db: Database;

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the fixture source scanner while grandfathering its pre-existing complexity.
function stripTypeScriptComments(source: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (quote !== null) {
      result += current;
      if (current === "\\" && next !== undefined) {
        result += next;
        index += 2;
        continue;
      }
      if (current === quote) quote = null;
      index++;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      result += current;
      index++;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        if (source[index] === "\n") result += "\n";
        index++;
      }
      continue;
    }
    result += current;
    index++;
  }
  return result;
}

const ROUTER_CONFIG: TaskRouterConfig = {
  mode: "auto",
  weights: {
    quality: 1,
    speed: 0.35,
    latency: 0.3,
    cost: 0.25,
    reliability: 0.75,
    affinity: 0.5,
    history: 0.6,
    quota: 0.2,
    uncertainty: 0.4,
    staleness: 0.1,
  },
  thresholds: {
    quality_floor: 0.5,
    context_safety_margin_tokens: 4096,
    max_fallbacks: 2,
    judge_confidence_floor: 0.6,
  },
  snapshot_ttl_seconds: 86_400,
};

const AGENTCHAT_CONFIG = {
  role_routing: {
    headroom_weighting: true,
    latency_weighting: false,
  },
  agents: [
    {
      name: "quality-seat",
      roles: [ROLE],
      pricing_mode: "subscription" as const,
      subscription_provider: "openai",
    },
    {
      name: "fast-seat",
      roles: [ROLE],
      pricing_mode: "api" as const,
      api_provider: "google",
    },
  ],
};

const ALIASES: ModelAliasMap = {
  "quality-seat": { aa_creator: "openai", aa_slug: "quality-model", reasoning_level: "high" },
  "fast-seat": { aa_creator: "google", aa_slug: "fast-model" },
};

function profile(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    schemaVersion: "1",
    taskTypes: ["coding"],
    complexity: 0.85,
    risk: 0.5,
    ambiguity: 0.2,
    codingDemand: 0.95,
    reasoningDemand: 0.75,
    agenticDemand: 0.9,
    contextDemand: 0.7,
    latencySensitivity: 0.1,
    costSensitivity: 0.1,
    reliabilityDemand: 0.9,
    expectedInputTokens: 2_000,
    expectedOutputTokens: 1_000,
    requiredCapabilities: [],
    preferredCapabilities: [],
    disallowedCapabilities: [],
    confidence: 0.9,
    rationale: ["Router orchestration fixture."],
    ...overrides,
  };
}

function aaModel(creator: string, slug: string, overrides: Partial<AaModel> = {}): AaModel {
  return {
    id: `${creator}-${slug}`,
    name: slug,
    slug,
    model_creator: { id: `${creator}-id`, name: creator, slug: creator },
    evaluations: {},
    pricing: {},
    ...overrides,
  };
}

function snapshot(models: AaModel[]): AaModelSnapshot {
  return {
    collectedAt: "2026-08-25T11:00:00.000Z",
    dataVersion: "test",
    models,
  };
}

function qualityVsFastSnapshot(): AaModelSnapshot {
  return snapshot([
    aaModel("openai", "quality-model", {
      evaluations: {
        artificial_analysis_intelligence_index: 95,
        artificial_analysis_coding_index: 98,
        terminalbench_hard: 0.95,
        terminalbench_v2_1: 0.96,
        tau2: 0.94,
      },
      pricing: { price_1m_input_tokens: 12, price_1m_output_tokens: 36 },
      median_output_tokens_per_second: 45,
      median_time_to_first_token_seconds: 12,
    }),
    aaModel("google", "fast-model", {
      evaluations: {
        artificial_analysis_intelligence_index: 45,
        artificial_analysis_coding_index: 42,
        terminalbench_hard: 0.35,
        terminalbench_v2_1: 0.38,
        tau2: 0.4,
      },
      pricing: { price_1m_input_tokens: 0.2, price_1m_output_tokens: 0.8 },
      median_output_tokens_per_second: 240,
      median_time_to_first_token_seconds: 0.2,
    }),
  ]);
}

function baseInput(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    mode: "auto",
    db,
    role: ROLE,
    message: "Implement a complex repository change",
    taskType: "implement_substantial",
    taskProfile: profile(),
    harnessContext: {},
    routerConfig: ROUTER_CONFIG,
    aliasMap: ALIASES,
    aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 3_600 },
    agentchatConfig: AGENTCHAT_CONFIG,
    agentRegistry: REGISTRY,
    ...overrides,
  };
}

function costOnlyConfig(): TaskRouterConfig {
  return {
    ...ROUTER_CONFIG,
    weights: {
      ...ROUTER_CONFIG.weights,
      quality: 0,
      speed: 0,
      latency: 0,
      cost: 1,
    },
  };
}

function costFactors(
  model: AaModel,
  taskProfile: TaskProfile,
): ReturnType<typeof computePriors>["factors"] {
  return computePriors({
    agentRegistry: ["quality-seat"],
    aliasMap: { "quality-seat": ALIASES["quality-seat"]! },
    aaSnapshot: { snapshot: snapshot([model]), stale: false, ageSeconds: 0 },
    taskProfile,
    routerConfig: costOnlyConfig(),
  }).factors;
}

function dependencies(overrides: Partial<RouterDependencies> = {}): RouterDependencies {
  return { now: () => NOW, ...overrides };
}

function seed(
  agent: string,
  options: { outcome?: "merged" | "failed"; latencyMs?: number } = {},
): void {
  const writer = new AgentPerformanceWriter(db);
  writer.upsert({
    performance_id: `${agent}-performance`,
    ts: "2026-08-25T10:00:00.000Z",
    handoff_id: `${agent}-handoff`,
    conversation_id: `${agent}-conversation`,
    project_id: "project",
    agent_name: agent,
    task_type: "implement_substantial",
    outcome: options.outcome ?? "merged",
    rounds: 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: 5,
    cost_usd: 0.01,
    tokens_used: 1_000,
    latency_ms: options.latencyMs ?? 1_000,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

describe("routing decide orchestrator", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seed("quality-seat");
    seed("fast-seat");
  });

  afterEach(() => {
    db.close();
  });

  test("mode:'off' returns without invoking routeAgent, the constraint filter, or any priors math", () => {
    const calls: string[] = [];
    const decision = decide(
      baseInput({ mode: "off" }),
      dependencies({
        routeAgent: (input) => {
          calls.push(`route:${input.detail}`);
          return routeAgent(input);
        },
        applyHardConstraints: (...args) => {
          calls.push("constraints");
          return { admitted: [...args[0]], excluded: [] };
        },
        computePriors: () => {
          calls.push("priors");
          return { priors: {}, factors: [], matchedModels: {} };
        },
      }),
    );

    expect(calls).toEqual([]);
    expect(decision.selected).toBeNull();
    expect(decision.explanation).toContain("Model task routing is disabled by configuration.");
  });

  test("a complex repo coding task selects on coding/terminal evidence over a faster cheaper candidate", () => {
    const decision = decide(baseInput(), dependencies());

    expect(decision.selected?.agent).toBe("quality-seat");
    expect(
      decision.factors.find((factor) => factor.name === "quality-seat.aa_prior")?.rawValue,
    ).toBeGreaterThan(1);
  });

  test("ranked-first keeps an unsampled registry-first candidate from bypassing the priors-scored rank", () => {
    db.run("DELETE FROM agent_performance");
    seed("fast-seat");

    const decision = decide(baseInput(), dependencies());

    expect(decision.selected?.agent).toBe("fast-seat");
    expect(
      decision.factors.find((factor) => factor.name === "quality-seat.aa_prior")?.rawValue,
    ).toBeGreaterThan(1);
  });

  test("a zero-history selection reports score zero and names the absent local history", () => {
    db.run("DELETE FROM agent_performance");

    const decision = decide(baseInput(), dependencies());

    expect(decision.selected?.agent).toBe("quality-seat");
    expect(decision.score).toBe(0);
    expect(decision.explanation).toContain(
      "Local history is absent for quality-seat; the reported score is 0.",
    );
  });

  test("a sampled agent hidden by bias filtering is reported as excluded and not selected", () => {
    const decision = decide(
      baseInput({
        activeBiases: [
          {
            bias_id: "exclude-quality",
            scope: "agent",
            value: "quality-seat",
            mode: "exclude",
            weight: null,
            reason: "operator exclusion",
            created_at: "2026-08-25T11:00:00.000Z",
            expires_at: "2026-08-26T11:00:00.000Z",
          },
        ],
        applyPressure: {
          snapshots: [
            {
              provider: "google",
              window_label: "daily",
              model: null,
              used_pct: 95,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
        },
      }),
      dependencies(),
    );

    expect(decision.selected).toBeNull();
    expect(decision.score).toBe(0);
    expect(decision.explanation).toContain("The routing engine returned no eligible selection.");
    expect(decision.alternatives).toContainEqual({
      routeId: "openai:quality-seat",
      excluded: true,
      reasons: ["routing_bias_exclude"],
    });
  });

  test("provider exclude biases fail closed per candidate when provider facts are unavailable", () => {
    seed("blocked-seat");
    seed("unknown-seat");
    seed("allowed-seat");

    const decision = decide(
      baseInput({
        agentRegistry: ["blocked-seat", "unknown-seat", "allowed-seat"],
        agentchatConfig: {
          role_routing: {
            headroom_weighting: true,
            latency_weighting: false,
          },
          agents: [
            {
              name: "blocked-seat",
              roles: [ROLE],
              pricing_mode: "subscription" as const,
              subscription_provider: "openai",
            },
            {
              name: "unknown-seat",
              roles: [ROLE],
            },
            {
              name: "allowed-seat",
              roles: [ROLE],
              pricing_mode: "api" as const,
              api_provider: "google",
            },
          ],
        },
        aliasMap: {},
        aaSnapshot: undefined,
        activeBiases: [
          {
            bias_id: "exclude-openai",
            scope: "provider",
            value: "openai",
            mode: "exclude",
            weight: null,
            reason: "operator exclusion",
            created_at: "2026-08-25T11:00:00.000Z",
            expires_at: "2026-08-26T11:00:00.000Z",
          },
        ],
      }),
      dependencies(),
    );

    expect(decision.selected?.agent).toBe("allowed-seat");
    expect(decision.alternatives).toContainEqual({
      routeId: "openai:blocked-seat",
      excluded: true,
      reasons: ["routing_bias_exclude"],
    });
    expect(decision.alternatives).toContainEqual({
      routeId: "unknown:unknown-seat",
      excluded: true,
      reasons: ["router_facts_unavailable"],
    });
  });

  test("a small formatting change selects the fast cheap candidate", () => {
    const decision = decide(
      baseInput({
        message: "Apply a tiny formatting change",
        taskType: "implement_substantial",
        taskProfile: profile({
          complexity: 0.1,
          codingDemand: 0.1,
          reasoningDemand: 0.1,
          agenticDemand: 0,
          latencySensitivity: 1,
          costSensitivity: 1,
        }),
      }),
      dependencies(),
    );

    expect(decision.selected?.agent).toBe("fast-seat");
  });

  test("quota pressure shifts selection while a paid-API candidate's cash-cost factor is untouched", () => {
    const unpressured = decide(baseInput(), dependencies());
    const pressured = decide(
      baseInput({
        applyPressure: {
          snapshots: [
            {
              provider: "openai",
              window_label: "weekly",
              model: null,
              used_pct: 85,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
        },
      }),
      dependencies(),
    );

    expect(unpressured.selected?.agent).toBe("quality-seat");
    expect(pressured.selected?.agent).toBe("fast-seat");
    const cashCost = (
      decision: ReturnType<typeof decide>,
    ): ReturnType<typeof decide>["factors"][number] | undefined =>
      decision.factors.find((factor) => factor.name === "fast-seat.predicted_cash_cost_usd");
    expect(cashCost(pressured)).toEqual(cashCost(unpressured));
    expect(pressured.factors.some((factor) => factor.name === "openai.subscription_pressure")).toBe(
      true,
    );
  });

  test("equal used_pct is scored equally regardless of whether quota resets in one hour or thirty days", () => {
    const decision = decide(
      baseInput({
        applyPressure: {
          snapshots: [
            {
              provider: "openai",
              window_label: "weekly",
              model: null,
              used_pct: 50,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
            {
              provider: "google",
              window_label: "monthly",
              model: null,
              used_pct: 50,
              resets_at: NOW.getTime() + 30 * 24 * 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
        },
      }),
      dependencies(),
    );

    const pressure = decision.factors.filter((factor) =>
      factor.name.endsWith(".subscription_pressure"),
    );
    expect(pressure.map((factor) => factor.normalizedValue)).toEqual([0.5, 0.5]);
  });

  test("an over-pressure candidate is absent from both fallbackChain and non-excluded alternatives", () => {
    const decision = decide(
      baseInput({
        applyPressure: {
          snapshots: [
            {
              provider: "openai",
              window_label: "weekly",
              model: null,
              used_pct: 95,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
        },
      }),
      dependencies(),
    );

    expect(decision.selected?.agent).toBe("fast-seat");
    expect(decision.fallbackChain).not.toContain("quality-seat");
    expect(
      decision.alternatives.some(
        (alternative) => alternative.routeId === "openai:quality-seat" && !alternative.excluded,
      ),
    ).toBe(false);
  });

  test("a stale-keyed pressure snapshot emits no pressure factor", () => {
    const decision = decide(
      baseInput({
        applyPressure: {
          snapshots: [
            {
              provider: "openai",
              window_label: "weekly",
              model: null,
              used_pct: 95,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
          warnings: [
            {
              code: "stale_snapshot",
              provider: "openai",
              window_label: "weekly",
              model: null,
              age_seconds: 7_200,
            },
          ],
        },
      }),
      dependencies(),
    );

    expect(decision.factors.some((factor) => factor.name === "openai.subscription_pressure")).toBe(
      false,
    );
  });

  test("the preferred candidate being unhealthy falls back to the next eligible one", () => {
    const decision = decide(
      baseInput({ unhealthyAgents: new Set(["quality-seat"]) }),
      dependencies(),
    );

    expect(decision.selected?.agent).toBe("fast-seat");
    expect(decision.alternatives).toContainEqual({
      routeId: "openai:quality-seat",
      excluded: true,
      reasons: ["unhealthy_or_unavailable"],
    });
  });

  test("an absent AA snapshot still yields a valid decision from local history + config and marks absence", () => {
    const decision = decide(baseInput({ aaSnapshot: undefined }), dependencies());

    expect(decision.selected).not.toBeNull();
    expect(decision.dataFreshness.artificial_analysis).toBe("absent");
    expect(RoutingDecisionSchema.safeParse(decision).success).toBe(true);
    expect(decision.factors.some((factor) => factor.source === "local_history")).toBe(true);
  });

  test("a stale snapshot lowers confidence versus an identical fresh one and discounts priors", () => {
    const fresh = decide(baseInput(), dependencies());
    const stale = decide(
      baseInput({
        aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: true, ageSeconds: 200_000 },
      }),
      dependencies(),
    );
    const prior = (decision: ReturnType<typeof decide>, agent: string): number =>
      Number(decision.factors.find((factor) => factor.name === `${agent}.aa_prior`)?.rawValue);

    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(Math.abs(prior(stale, "quality-seat") - 1)).toBeLessThan(
      Math.abs(prior(fresh, "quality-seat") - 1),
    );
  });

  test("a months-stale snapshot discounts priors more than a barely-stale snapshot", () => {
    const barelyStaleAge = ROUTER_CONFIG.snapshot_ttl_seconds;
    const monthsStaleAge = 120 * 24 * 60 * 60;
    const barelyStale = decide(
      baseInput({
        aaSnapshot: {
          snapshot: qualityVsFastSnapshot(),
          stale: true,
          ageSeconds: barelyStaleAge,
        },
      }),
      dependencies(),
    );
    const monthsStale = decide(
      baseInput({
        aaSnapshot: {
          snapshot: qualityVsFastSnapshot(),
          stale: true,
          ageSeconds: monthsStaleAge,
        },
      }),
      dependencies(),
    );
    const prior = (decision: ReturnType<typeof decide>): number =>
      Number(decision.factors.find((factor) => factor.name === "quality-seat.aa_prior")?.rawValue);

    expect(Math.abs(prior(monthsStale) - 1)).toBeLessThan(Math.abs(prior(barelyStale) - 1));
    expect(
      barelyStale.factors.find((factor) => factor.name === "aa_staleness_discount")?.rawValue,
    ).toBe(barelyStaleAge);
    expect(
      monthsStale.factors.find((factor) => factor.name === "aa_staleness_discount")?.rawValue,
    ).toBe(monthsStaleAge);
  });

  test("a non-finite stale age is maximally stale and still yields a schema-valid decision", () => {
    const decision = decide(
      baseInput({
        aaSnapshot: {
          snapshot: qualityVsFastSnapshot(),
          stale: true,
          ageSeconds: Infinity,
        },
      }),
      dependencies(),
    );
    const discount = decision.factors.find((factor) => factor.name === "aa_staleness_discount");

    expect(RoutingDecisionSchema.safeParse(decision).success).toBe(true);
    expect(discount?.rawValue).toBe("unknown");
    expect(discount?.normalizedValue).toBe(0.9);
  });

  test("an ambiguous alias applies priors to neither candidate", () => {
    const duplicated = qualityVsFastSnapshot();
    duplicated.models.push({ ...duplicated.models[0]!, id: "duplicate-quality" });
    duplicated.models.push({ ...duplicated.models[1]!, id: "duplicate-fast" });
    const decision = decide(
      baseInput({ aaSnapshot: { snapshot: duplicated, stale: false, ageSeconds: 0 } }),
      dependencies(),
    );

    expect(decision.factors.filter((factor) => factor.name.endsWith(".aa_prior"))).toEqual([]);
  });

  test("identical inputs with fixed injected now produce byte-identical decisions including alternatives ordering", () => {
    const input = baseInput();
    const first = JSON.stringify(decide(input, dependencies()));
    const second = JSON.stringify(decide(input, dependencies()));

    expect(second).toBe(first);
  });

  test("an empty admitted pool returns a no-selection decision carrying every exclusion reason", () => {
    const facts: Record<string, CandidateConstraintFacts> = {
      "quality-seat": { healthy: false, quotaExhausted: true, deniedByConfig: true },
      "fast-seat": { healthy: false, quotaExhausted: true, deniedByConfig: true },
    };
    const decision = decide(
      baseInput({
        perCandidateFacts: facts,
        applyPressure: {
          snapshots: [
            {
              provider: "openai",
              window_label: "weekly",
              model: null,
              used_pct: 50,
              resets_at: NOW.getTime() + 3_600_000,
              observed_at: NOW.toISOString(),
              source_kind: "subscription",
            },
          ],
        },
      }),
      dependencies(),
    );

    expect(decision.selected).toBeNull();
    expect(decision.alternatives).toEqual([
      {
        routeId: "openai:quality-seat",
        excluded: true,
        reasons: ["unhealthy_or_unavailable", "quota_exhausted", "denied_by_config"],
      },
      {
        routeId: "google:fast-seat",
        excluded: true,
        reasons: ["unhealthy_or_unavailable", "quota_exhausted", "denied_by_config"],
      },
    ]);
    expect(decision.factors.some((factor) => factor.name === "openai.subscription_pressure")).toBe(
      true,
    );
  });

  test("decide passes the registry and ranked-first policy to both real routeAgent calls", () => {
    const captured: {
      registry: DecideInput["agentRegistry"];
      policy: "unsampled-first" | "ranked-first" | undefined;
    }[] = [];
    decide(
      baseInput(),
      dependencies({
        routeAgent: (input) => {
          captured.push({
            registry: input.agentRegistry ?? [],
            policy: input.roleExplorationPolicy,
          });
          return routeAgent(input);
        },
      }),
    );

    expect(captured).toEqual([
      { registry: REGISTRY, policy: "ranked-first" },
      { registry: REGISTRY, policy: "ranked-first" },
    ]);
  });

  test("role routing fences a registry name that has no config row", () => {
    let capturedFacts: Readonly<Record<string, CandidateConstraintFacts | undefined>> | undefined;
    const decision = decide(
      baseInput({
        agentRegistry: ["missing-config-seat", "quality-seat"],
      }),
      dependencies({
        applyHardConstraints: (candidates, taskProfile, harnessContext, facts, config) => {
          capturedFacts = facts;
          return applyHardConstraints(candidates, taskProfile, harnessContext, facts, config);
        },
      }),
    );

    expect(capturedFacts?.["missing-config-seat"]?.roleRoutingRolesEmpty).toBe(true);
    expect(decision.selected?.agent).toBe("quality-seat");
  });

  test("agent-name keyed accumulators have null prototypes", () => {
    const priors = computePriors({
      agentRegistry: REGISTRY,
      aliasMap: ALIASES,
      aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 0 },
      taskProfile: profile(),
      routerConfig: ROUTER_CONFIG,
    });
    let capturedFacts: Readonly<Record<string, CandidateConstraintFacts | undefined>> | undefined;

    decide(
      baseInput(),
      dependencies({
        applyHardConstraints: (candidates, _taskProfile, _harnessContext, facts) => {
          capturedFacts = facts;
          return { admitted: [...candidates], excluded: [] };
        },
      }),
    );

    expect(Object.getPrototypeOf(priors.priors)).toBeNull();
    expect(Object.getPrototypeOf(priors.matchedModels)).toBeNull();
    expect(Object.getPrototypeOf(capturedFacts!)).toBeNull();
  });

  test("computePriors emits an alias_reconciliation factor for every registry agent, including unmatched ones", () => {
    const registry = ["matched-seat", "no-alias-seat", "no-model-seat", "multi-model-seat"];
    const aliasMap: ModelAliasMap = {
      "matched-seat": { aa_creator: "openai", aa_slug: "quality-model" },
      "no-model-seat": { aa_creator: "openai", aa_slug: "missing-model" },
      "multi-model-seat": { aa_creator: "openai", aa_slug: "dup-model" },
    };
    const aaSnapshot = snapshot([
      aaModel("openai", "quality-model"),
      aaModel("openai", "dup-model"),
      aaModel("openai", "dup-model"),
    ]);

    const result = computePriors({
      agentRegistry: registry,
      aliasMap,
      aaSnapshot: { snapshot: aaSnapshot, stale: false, ageSeconds: 0 },
      taskProfile: profile(),
      routerConfig: ROUTER_CONFIG,
    });

    const reconciliationFactors = Object.fromEntries(
      result.factors
        .filter((factor) => factor.name.endsWith(".alias_reconciliation"))
        .map((factor) => [factor.name, factor]),
    );

    expect(reconciliationFactors).toEqual({
      "matched-seat.alias_reconciliation": {
        name: "matched-seat.alias_reconciliation",
        rawValue: "matched",
        weight: 0,
        contribution: 0,
        source: "artificial_analysis",
      },
      "no-alias-seat.alias_reconciliation": {
        name: "no-alias-seat.alias_reconciliation",
        rawValue: "no_alias_configured",
        weight: 0,
        contribution: 0,
        source: "config",
      },
      "no-model-seat.alias_reconciliation": {
        name: "no-model-seat.alias_reconciliation",
        rawValue: "alias_matches_no_snapshot_model",
        weight: 0,
        contribution: 0,
        source: "artificial_analysis",
      },
      "multi-model-seat.alias_reconciliation": {
        name: "multi-model-seat.alias_reconciliation",
        rawValue: "alias_matches_multiple_snapshot_models",
        weight: 0,
        contribution: 0,
        source: "artificial_analysis",
      },
    });
  });

  test("reconciliationFactorFields reports reconciliation_missing when the seat has no reconciliation entry at all", () => {
    expect(reconciliationFactorFields(undefined)).toEqual({
      rawValue: "reconciliation_missing",
      source: "config",
    });
  });

  test("reconciliation outcomes of a zero-weight-factor-only agent never move any agent's priors", () => {
    const registry = ["quality-seat", "fast-seat", "zero-weight-seat"];
    const aaSnapshot = { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 0 };

    const noAliasResult = computePriors({
      agentRegistry: registry,
      aliasMap: ALIASES,
      aaSnapshot,
      taskProfile: profile(),
      routerConfig: ROUTER_CONFIG,
    });

    const unmatchedAliasResult = computePriors({
      agentRegistry: registry,
      aliasMap: {
        ...ALIASES,
        "zero-weight-seat": { aa_creator: "openai", aa_slug: "no-such-model" },
      },
      aaSnapshot,
      taskProfile: profile(),
      routerConfig: ROUTER_CONFIG,
    });

    const noAliasFactor = noAliasResult.factors.find(
      (factor) => factor.name === "zero-weight-seat.alias_reconciliation",
    );
    const unmatchedAliasFactor = unmatchedAliasResult.factors.find(
      (factor) => factor.name === "zero-weight-seat.alias_reconciliation",
    );
    expect(noAliasFactor?.rawValue).toBe("no_alias_configured");
    expect(unmatchedAliasFactor?.rawValue).toBe("alias_matches_no_snapshot_model");
    expect(noAliasFactor?.source).not.toBe(unmatchedAliasFactor?.source);

    expect(unmatchedAliasResult.priors).toEqual(noAliasResult.priors);
  });

  test("the returned decision validates against RoutingDecisionSchema", () => {
    expect(RoutingDecisionSchema.parse(decide(baseInput(), dependencies()))).toBeDefined();
  });

  test("the committed live AA fixture remains parseable for router inputs", () => {
    const parsed = AaModelSnapshotSchema.parse({
      collectedAt: NOW.toISOString(),
      models: aaLiveSample.data,
    });
    expect(parsed.models).toHaveLength(3);
  });
});

test("deterministic routing sources recursively avoid ambient randomness and clocks", () => {
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/routing");
  const injectedClockBoundaries = new Set(["aa-client.ts", "aa-snapshot-store.ts"]);
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
  const forbidden = [
    /\bDate\.now\s*\(/,
    /\bMath\.random\s*\(/,
    /\bnew\s+Date\s*\(\s*\)/,
    /\bperformance\.now\s*\(/,
  ];
  const offenders = sourceFiles(sourceDir)
    .filter((path) => {
      const relativePath = relative(sourceDir, path);
      let source = stripTypeScriptComments(readFileSync(path, "utf8"));
      if (injectedClockBoundaries.has(relativePath)) {
        source = source.replace(
          /opts\.now \?\? \(\(\): Date => new Date\(\)\)|opts\.now \?\? \(\(\) => new Date\(\)\)/,
          "opts.now",
        );
      }
      return forbidden.some((pattern) => pattern.test(source));
    })
    .map((path) => relative(sourceDir, path));

  expect(offenders).toEqual([]);
});

test("determinism comment stripping preserves code after comment markers inside strings", () => {
  expect(stripTypeScriptComments('const marker = "x//y"; Date.now();')).toContain("Date.now()");
});

describe("predicted AA cash cost", () => {
  test("uses the input/output price ratio with their corresponding token counts", () => {
    const factors = costFactors(
      aaModel("openai", "quality-model", {
        pricing: {
          price_1m_input_tokens: 2,
          price_1m_output_tokens: 8,
          price_1m_blended_3_to_1: 999,
        },
      }),
      profile({ expectedInputTokens: 2_000_000, expectedOutputTokens: 1_000_000 }),
    );

    expect(
      factors.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe(12);
  });

  test("keeps cost unknown when only one directional price exists, even with a blended price", () => {
    const factors = costFactors(
      aaModel("openai", "quality-model", {
        pricing: {
          price_1m_input_tokens: 2,
          price_1m_blended_3_to_1: 4,
        },
      }),
      profile(),
    );

    expect(
      factors.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe("unknown");
  });

  test("keeps cost unknown for negative or non-finite token counts", () => {
    const model = aaModel("openai", "quality-model", {
      pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 8 },
    });
    const negative = costFactors(
      model,
      profile({ expectedInputTokens: -1, expectedOutputTokens: 1_000 }),
    );
    const nonFinite = costFactors(
      model,
      profile({ expectedInputTokens: 1_000, expectedOutputTokens: Number.NaN }),
    );

    expect(
      negative.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe("unknown");
    expect(
      nonFinite.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe("unknown");
  });

  test("keeps cost unknown for negative or non-finite directional prices", () => {
    const negative = costFactors(
      aaModel("openai", "quality-model", {
        pricing: { price_1m_input_tokens: -1, price_1m_output_tokens: 8 },
      }),
      profile(),
    );
    const nonFinite = costFactors(
      aaModel("openai", "quality-model", {
        pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: Number.NaN },
      }),
      profile(),
    );

    expect(
      negative.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe("unknown");
    expect(
      nonFinite.find((factor) => factor.name === "quality-seat.predicted_cash_cost_usd")?.rawValue,
    ).toBe("unknown");
  });
});
