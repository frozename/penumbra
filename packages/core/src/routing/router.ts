import type { ModelAliasMap, TaskRouterConfig } from "@penumbra/config";
import type { Database } from "bun:sqlite";

import type { RoutingBias } from "../readers/routing-bias.js";
import type { AgentTaskType } from "../schemas/agent-performance.js";

import {
  buildPressureStaleKeys,
  isTextOnlyAdapter,
  pressureSnapshotKey,
  resolveBiasEffect,
  resolveProvider,
  routeAgent,
  type RouteAgentInput,
  type RouteAgentOutput,
} from "../services/agent-routing.js";
import { type AliasReconciliationResult, buildAliasIndex, reconcileAliases } from "./alias-map.js";
import {
  applyHardConstraints,
  type CandidateConstraintFacts,
  type HardConstraintFilterResult,
} from "./constraint-filter.js";
import {
  type AaModel,
  type AaModelSnapshot,
  type HarnessContext,
  type RoutingDecision,
  RoutingDecisionSchema,
  type RoutingFactorSource,
  type TaskProfile,
} from "./schemas.js";

const ROUTER_SCHEMA_VERSION = "1";
const PRIOR_MIN = 0.5;
const PRIOR_MAX = 1.5;

type StoredSnapshotShape = {
  provenance: {
    collectedAt: string;
    dataVersion?: string;
    benchmarkVersion?: string;
  };
  models: AaModel[];
};

export type RouterAaSnapshot = {
  snapshot: AaModelSnapshot | StoredSnapshotShape;
  stale: boolean;
  ageSeconds?: number;
};

export interface DecideInput {
  mode: "off" | "recommend" | "shadow" | "auto";
  db: Database;
  role: string;
  message: string;
  taskType?: AgentTaskType;
  taskProfile: TaskProfile;
  harnessContext: HarnessContext;
  routerConfig: TaskRouterConfig;
  aliasMap: ModelAliasMap;
  aaSnapshot?: RouterAaSnapshot;
  agentchatConfig: NonNullable<RouteAgentInput["agentchatConfig"]>;
  agentRegistry: readonly string[];
  activeBiases?: RoutingBias[];
  applyPressure?: RouteAgentInput["applyPressure"];
  unhealthyAgents?: ReadonlySet<string>;
  perCandidateFacts?: Readonly<Record<string, CandidateConstraintFacts | undefined>>;
}

export interface ComputePriorsInput {
  agentRegistry: readonly string[];
  aliasMap: ModelAliasMap;
  aaSnapshot?: RouterAaSnapshot;
  taskProfile: TaskProfile;
  routerConfig: TaskRouterConfig;
}

export interface ComputePriorsResult {
  priors: Record<string, number>;
  factors: RoutingDecision["factors"];
  matchedModels: Record<string, AaModel>;
}

export interface RouterDependencies {
  now: () => Date;
  routeAgent?: (input: RouteAgentInput) => RouteAgentOutput;
  applyHardConstraints?: typeof applyHardConstraints;
  computePriors?: (input: ComputePriorsInput) => ComputePriorsResult;
}

type MetricSpec = {
  name: string;
  weight: number;
  inverse?: boolean;
  read: (model: AaModel, predictedCostUsd: number | undefined) => number | undefined;
};

type CandidateMetric = {
  agent: string;
  metric: MetricSpec;
  rawValue: number;
  normalizedValue: number;
};

export function decide(input: DecideInput, deps: RouterDependencies): RoutingDecision {
  if (input.mode === "off") {
    return RoutingDecisionSchema.parse({
      selected: null,
      taskProfile: input.taskProfile,
      score: 0,
      confidence: round(input.taskProfile.confidence),
      alternatives: [],
      factors: [
        {
          name: "router_mode",
          rawValue: "off",
          source: "config",
        },
      ],
      fallbackChain: [],
      dataFreshness: dataFreshness(input.aaSnapshot),
      explanation: ["Model task routing is disabled by configuration."],
      routerSchemaVersion: ROUTER_SCHEMA_VERSION,
    });
  }

  const compute = deps.computePriors ?? computePriors;
  const constraints = deps.applyHardConstraints ?? applyHardConstraints;
  const route = deps.routeAgent ?? routeAgent;
  const priorResult = compute({
    agentRegistry: input.agentRegistry,
    aliasMap: input.aliasMap,
    aaSnapshot: input.aaSnapshot,
    taskProfile: input.taskProfile,
    routerConfig: input.routerConfig,
  });
  const facts = buildCandidateFacts(input, priorResult.matchedModels);
  const constraintResult = constraints(
    input.agentRegistry,
    input.taskProfile,
    input.harnessContext,
    facts,
    {
      context_safety_margin_tokens: input.routerConfig.thresholds.context_safety_margin_tokens,
      max_predicted_cost_usd_per_dispatch: input.routerConfig.max_predicted_cost_usd_per_dispatch,
    },
  );

  if (constraintResult.admitted.length === 0) {
    return noSelectionDecision(input, priorResult, constraintResult);
  }
  const biasConstraintResult = applyRoutingBiasExclusions(input, constraintResult.admitted);
  const combinedConstraintResult: HardConstraintFilterResult = {
    admitted: biasConstraintResult.admitted,
    excluded: [...constraintResult.excluded, ...biasConstraintResult.excluded],
  };
  if (combinedConstraintResult.admitted.length === 0) {
    return noSelectionDecision(input, priorResult, combinedConstraintResult);
  }

  const now = deps.now();
  const commonRouteInput = {
    db: input.db,
    taskType: input.taskType,
    role: input.role,
    message: input.message,
    agentchatConfig: input.agentchatConfig,
    agentRegistry: [...input.agentRegistry],
    allowRoleExploration: true,
    activeBiases: input.activeBiases,
    applyPressure: input.applyPressure,
    unhealthyAgents: input.unhealthyAgents,
    hardExcludedAgents: new Set(
      combinedConstraintResult.excluded.map((candidate) => candidate.agent),
    ),
    priors: priorResult.priors,
    roleExplorationPolicy: "ranked-first" as const,
    tool_free: input.harnessContext.toolFree,
    now,
  } satisfies Omit<RouteAgentInput, "detail">;

  // Follow-up seam: a combined engine detail mode can remove the duplicate routeAgent call;
  // that engine pass can also index per-agent metrics and memoize provider lookups once.
  const rankOutput = route({ ...commonRouteInput, detail: "rank" });
  const singleOutput = route({ ...commonRouteInput, detail: "single" });
  if (rankOutput.detail !== "rank" || singleOutput.detail !== "single") {
    throw new Error("routeAgent dependency returned a mismatched detail output");
  }

  const ranked = rankOutput.candidates.candidates;
  const selectedAgent = singleOutput.route?.agent ?? null;
  const selectedRank = ranked.find((candidate) => candidate.agent_name === selectedAgent);
  let selectedHasLocalHistory = selectedRank !== undefined;
  if (
    !selectedHasLocalHistory &&
    selectedAgent !== null &&
    input.activeBiases !== undefined &&
    input.activeBiases.length > 0
  ) {
    const unsteeredRankOutput = route({
      ...commonRouteInput,
      activeBiases: undefined,
      detail: "rank",
    });
    if (unsteeredRankOutput.detail !== "rank") {
      throw new Error("routeAgent dependency returned a mismatched detail output");
    }
    selectedHasLocalHistory = unsteeredRankOutput.candidates.candidates.some(
      (candidate) => candidate.agent_name === selectedAgent,
    );
  }
  const selected = selectedAgent === null ? null : selectedRoute(input, selectedAgent);
  const rankedAlternatives = ranked
    .filter((candidate) => candidate.agent_name !== selectedAgent)
    .filter((candidate) => passesPressure(input, candidate.agent_name))
    .map((candidate) => ({
      routeId: routeId(input, candidate.agent_name),
      score: candidate.score,
      excluded: false,
      reasons: ["Scored but not selected by the routing engine."],
    }));
  const excludedAlternatives = excludedToAlternatives(input, combinedConstraintResult);
  const fallbackChain = ranked
    .map((candidate) => candidate.agent_name)
    .filter((agent) => agent !== selectedAgent)
    .filter((agent) => passesPressure(input, agent))
    .slice(0, input.routerConfig.thresholds.max_fallbacks);
  const confidence = routingConfidence(input.taskProfile, input.aaSnapshot);
  const factors = [
    ...priorResult.factors,
    ...historyFactors(ranked, input.routerConfig),
    ...pressureFactors(input),
    { name: "router_mode", rawValue: input.mode, source: "config" as const },
  ];

  return RoutingDecisionSchema.parse({
    selected,
    taskProfile: input.taskProfile,
    score: round(selectedRank?.score ?? 0),
    confidence,
    alternatives: [...rankedAlternatives, ...excludedAlternatives],
    factors,
    fallbackChain,
    dataFreshness: dataFreshness(input.aaSnapshot),
    explanation:
      selected === null
        ? ["The routing engine returned no eligible selection."]
        : [
            `Selected ${selected.agent} from ${String(combinedConstraintResult.admitted.length)} admitted candidates.`,
            input.aaSnapshot
              ? `Artificial Analysis priors were ${input.aaSnapshot.stale ? "stale and discounted" : "fresh"}.`
              : "Artificial Analysis priors were absent; routing used local history and configuration.",
            ...(selectedRank
              ? []
              : selectedHasLocalHistory
                ? [
                    `Local history exists for ${selected.agent}, but routing filters removed its rank entry; the reported score is 0.`,
                  ]
                : [`Local history is absent for ${selected.agent}; the reported score is 0.`]),
          ],
    routerSchemaVersion: ROUTER_SCHEMA_VERSION,
  });
}

// reconcileAliases is total over the seat list it's given, so `reconciliation`
// is undefined only if that invariant regresses. "reconciliation_missing" makes
// that regression visible in the decision log instead of silently reporting
// "matched".
export function reconciliationFactorFields(reconciliation: AliasReconciliationResult | undefined): {
  rawValue: string;
  source: RoutingFactorSource;
} {
  const rawValue =
    reconciliation === undefined
      ? "reconciliation_missing"
      : "unmatched" in reconciliation
        ? reconciliation.unmatched
        : "matched";
  // Only "no_alias_configured" and "reconciliation_missing" are local/config
  // gaps resolved before any AA snapshot lookup runs (see reconcileAliases).
  // The other two unmatched reasons and "matched" all require the snapshot,
  // so they keep the "artificial_analysis" source. RoutingFactorSource has no
  // enum value more specific than "config" for a local reconciliation gap;
  // reuse it rather than widen the schema for two call sites.
  const source: RoutingFactorSource =
    rawValue === "reconciliation_missing" || rawValue === "no_alias_configured"
      ? "config"
      : "artificial_analysis";
  return { rawValue, source };
}

export function computePriors(input: ComputePriorsInput): ComputePriorsResult {
  if (!input.aaSnapshot) {
    return { priors: nullRecord(), factors: [], matchedModels: nullRecord() };
  }

  const snapshot = normalizeSnapshot(input.aaSnapshot.snapshot);
  const reconciled = reconcileAliases(
    buildAliasIndex(input.aliasMap),
    snapshot,
    input.agentRegistry,
  );
  const matchedModels = nullRecord<AaModel>();
  for (const agent of input.agentRegistry) {
    const result = reconciled[agent];
    if (result && "matched" in result) matchedModels[agent] = result.matched;
  }

  const metricSpecs = buildMetricSpecs(input.taskProfile, input.routerConfig);
  const predictedCosts = nullRecord<number | undefined>();
  for (const [agent, model] of Object.entries(matchedModels)) {
    predictedCosts[agent] = predictedCostUsd(model, input.taskProfile);
  }
  const metrics = normalizeCandidateMetrics(
    input.agentRegistry,
    matchedModels,
    predictedCosts,
    metricSpecs,
  );
  const staleAgeRatio = stalenessAgeRatio(input.aaSnapshot, input.routerConfig);
  const staleRetention = input.aaSnapshot.stale
    ? clamp01(1 - input.routerConfig.weights.staleness * staleAgeRatio)
    : 1;
  const priors = nullRecord<number>();
  const factors: RoutingDecision["factors"] = [];
  const costMetric = metricSpecs.find((metric) => metric.name === "predicted_cash_cost_usd");

  for (const agent of input.agentRegistry) {
    const reconciliation = reconciled[agent];
    const { rawValue, source } = reconciliationFactorFields(reconciliation);
    // Measured 2026-08-26: ~132-167 bytes on the wire per alias_reconciliation
    // factor, ~5.5-7KB per routing_decisions row at 42 registered seats. That
    // growth is a stated decision, not an accident — bounding it (if it ever
    // needs bounding) is owned by the named routing_decisions 90d-retention
    // sweeper follow-up, not this call site.
    factors.push({
      name: `${agent}.alias_reconciliation`,
      rawValue,
      weight: 0,
      contribution: 0,
      source,
    });
    if (!matchedModels[agent]) continue;
    const agentMetrics = metrics.filter((candidate) => candidate.agent === agent);
    if (costMetric && costMetric.weight > 0 && predictedCosts[agent] === undefined) {
      factors.push({
        name: `${agent}.predicted_cash_cost_usd`,
        rawValue: "unknown",
        weight: round(costMetric.weight),
        source: "artificial_analysis",
      });
    }
    if (agentMetrics.length === 0) continue;
    const totalWeight = agentMetrics.reduce((sum, candidate) => sum + candidate.metric.weight, 0);
    const rawDelta =
      totalWeight === 0
        ? 0
        : agentMetrics.reduce(
            (sum, candidate) => sum + (candidate.normalizedValue - 0.5) * candidate.metric.weight,
            0,
          ) / totalWeight;
    const prior = round(clamp(1 + rawDelta * staleRetention, PRIOR_MIN, PRIOR_MAX));
    priors[agent] = prior;

    for (const candidate of agentMetrics) {
      factors.push({
        name: `${agent}.${candidate.metric.name}`,
        rawValue: round(candidate.rawValue),
        normalizedValue: round(candidate.normalizedValue),
        weight: round(candidate.metric.weight),
        contribution: round(
          (candidate.normalizedValue - 0.5) * candidate.metric.weight * staleRetention,
        ),
        source: "artificial_analysis",
      });
    }
    factors.push({
      name: `${agent}.aa_prior`,
      rawValue: prior,
      normalizedValue: round(clamp01(prior - PRIOR_MIN)),
      weight: 1,
      contribution: round(prior - 1),
      source: "artificial_analysis",
    });
  }

  if (input.aaSnapshot.stale) {
    factors.push({
      name: "aa_staleness_discount",
      rawValue:
        input.aaSnapshot.ageSeconds !== undefined && Number.isFinite(input.aaSnapshot.ageSeconds)
          ? input.aaSnapshot.ageSeconds
          : "unknown",
      normalizedValue: round(staleRetention),
      weight: round(input.routerConfig.weights.staleness),
      contribution: round(staleRetention - 1),
      source: "config",
    });
  }

  return { priors, factors, matchedModels };
}

function buildMetricSpecs(profile: TaskProfile, config: TaskRouterConfig): MetricSpec[] {
  const codingWeight =
    config.weights.quality * ((profile.codingDemand + profile.agenticDemand) / 2);
  return [
    {
      name: "coding_index",
      weight: codingWeight,
      read: (model) => finite(model.evaluations.artificial_analysis_coding_index),
    },
    {
      name: "terminalbench_hard",
      weight: codingWeight,
      read: (model) => finite(model.evaluations.terminalbench_hard),
    },
    {
      name: "terminalbench_v2_1",
      weight: codingWeight,
      read: (model) => finite(model.evaluations.terminalbench_v2_1),
    },
    {
      name: "tau2",
      weight: codingWeight,
      read: (model) => finite(model.evaluations.tau2),
    },
    {
      name: "intelligence_index",
      weight: config.weights.quality * profile.reasoningDemand,
      read: (model) => finite(model.evaluations.artificial_analysis_intelligence_index),
    },
    {
      name: "output_tokens_per_second",
      weight: config.weights.speed * profile.latencySensitivity,
      read: (model) => finite(model.median_output_tokens_per_second),
    },
    {
      name: "time_to_first_token_seconds",
      weight: config.weights.latency * profile.latencySensitivity,
      inverse: true,
      read: (model) =>
        finite(model.median_time_to_first_token_seconds ?? model.median_time_to_first_answer_token),
    },
    {
      name: "predicted_cash_cost_usd",
      weight: config.weights.cost * profile.costSensitivity,
      inverse: true,
      read: (_model, predictedCost) => predictedCost,
    },
  ];
}

function normalizeCandidateMetrics(
  agents: readonly string[],
  models: Readonly<Record<string, AaModel>>,
  predictedCosts: Readonly<Record<string, number | undefined>>,
  metricSpecs: readonly MetricSpec[],
): CandidateMetric[] {
  const result: CandidateMetric[] = [];
  for (const metric of metricSpecs) {
    if (metric.weight === 0) continue;
    const values = agents
      .map((agent) => ({
        agent,
        value: models[agent] ? metric.read(models[agent], predictedCosts[agent]) : undefined,
      }))
      .filter((entry): entry is { agent: string; value: number } => entry.value !== undefined);
    if (values.length === 0) continue;
    const min = Math.min(...values.map((entry) => entry.value));
    const max = Math.max(...values.map((entry) => entry.value));
    for (const entry of values) {
      const normalized = min === max ? 0.5 : (entry.value - min) / (max - min);
      result.push({
        agent: entry.agent,
        metric,
        rawValue: entry.value,
        normalizedValue: metric.inverse ? 1 - normalized : normalized,
      });
    }
  }
  return result;
}

function buildCandidateFacts(
  input: DecideInput,
  models: Readonly<Record<string, AaModel>>,
): Record<string, CandidateConstraintFacts> {
  const facts = nullRecord<CandidateConstraintFacts>();
  for (const agent of input.agentRegistry) {
    const supplied = Object.hasOwn(input.perCandidateFacts ?? {}, agent)
      ? (input.perCandidateFacts?.[agent] ?? {})
      : {};
    const agentConfig = input.agentchatConfig.agents.find((candidate) => candidate.name === agent);
    const predictedCost = models[agent]
      ? predictedCostUsd(models[agent], input.taskProfile)
      : undefined;
    facts[agent] = {
      ...supplied,
      // healthy undefined means not probed and intentionally remains fail-open.
      healthy: input.unhealthyAgents?.has(agent) ? false : supplied.healthy,
      // Unknown predicted cost intentionally passes the budget cap; unknown is never zero.
      predictedCostUsd: supplied.predictedCostUsd ?? predictedCost,
      roleRoutingRolesEmpty:
        supplied.roleRoutingRolesEmpty ??
        (input.role ? agentConfig === undefined || agentConfig.roles.length === 0 : false),
      textOnlyAdapter: supplied.textOnlyAdapter ?? isTextOnlyAdapter(agentConfig?.adapter),
    };
  }
  return facts;
}

function predictedCostUsd(model: AaModel, profile: TaskProfile): number | undefined {
  const inputTokens = profile.expectedInputTokens;
  const outputTokens = profile.expectedOutputTokens;
  const finiteInputTokens = finiteNonNegative(inputTokens);
  const finiteOutputTokens = finiteNonNegative(outputTokens);
  const inputPrice = finiteNonNegative(model.pricing.price_1m_input_tokens);
  const outputPrice = finiteNonNegative(model.pricing.price_1m_output_tokens);
  if (
    finiteInputTokens === undefined ||
    finiteOutputTokens === undefined ||
    inputPrice === undefined ||
    outputPrice === undefined
  ) {
    return undefined;
  }
  return round((finiteInputTokens * inputPrice + finiteOutputTokens * outputPrice) / 1_000_000);
}

function noSelectionDecision(
  input: DecideInput,
  priorResult: ComputePriorsResult,
  constraintResult: HardConstraintFilterResult,
): RoutingDecision {
  return RoutingDecisionSchema.parse({
    selected: null,
    taskProfile: input.taskProfile,
    score: 0,
    confidence: routingConfidence(input.taskProfile, input.aaSnapshot),
    alternatives: excludedToAlternatives(input, constraintResult),
    factors: [
      ...priorResult.factors,
      ...pressureFactors(input),
      { name: "router_mode", rawValue: input.mode, source: "config" as const },
    ],
    fallbackChain: [],
    dataFreshness: dataFreshness(input.aaSnapshot),
    explanation: ["Every registered candidate was excluded by a hard constraint."],
    routerSchemaVersion: ROUTER_SCHEMA_VERSION,
  });
}

function applyRoutingBiasExclusions(
  input: DecideInput,
  candidates: readonly string[],
): HardConstraintFilterResult {
  if (!input.activeBiases || input.activeBiases.length === 0) {
    return { admitted: [...candidates], excluded: [] };
  }
  const hasProviderExclude = input.activeBiases.some(
    (bias) => bias.scope === "provider" && bias.mode === "exclude",
  );
  const admitted: string[] = [];
  const excluded: { agent: string; reasons: string[] }[] = [];
  for (const agent of candidates) {
    const agentConfig = input.agentchatConfig.agents.find((candidate) => candidate.name === agent);
    const provider = agentConfig ? resolveProvider(agentConfig) : null;
    if (hasProviderExclude && provider === null) {
      excluded.push({ agent, reasons: ["router_facts_unavailable"] });
      continue;
    }
    if (resolveBiasEffect(agent, provider, input.activeBiases).exclude) {
      excluded.push({ agent, reasons: ["routing_bias_exclude"] });
    } else {
      admitted.push(agent);
    }
  }
  return { admitted, excluded };
}

function selectedRoute(
  input: DecideInput,
  agent: string,
): NonNullable<RoutingDecision["selected"]> {
  const provider = providerFor(input, agent);
  const reasoningLevel = input.aliasMap[agent]?.reasoning_level;
  return {
    agent,
    provider,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    routeId: `${provider}:${agent}`,
  };
}

function excludedToAlternatives(
  input: DecideInput,
  constraints: HardConstraintFilterResult,
): RoutingDecision["alternatives"] {
  return constraints.excluded.map((candidate) => ({
    routeId: routeId(input, candidate.agent),
    excluded: true,
    reasons: candidate.reasons,
  }));
}

function routeId(input: DecideInput, agent: string): string {
  return `${providerFor(input, agent)}:${agent}`;
}

function providerFor(input: DecideInput, agent: string): string {
  const config = input.agentchatConfig.agents.find((candidate) => candidate.name === agent);
  return (config ? resolveProvider(config) : null) ?? "unknown";
}

function historyFactors(
  candidates: Extract<RouteAgentOutput, { detail: "rank" }>["candidates"]["candidates"],
  config: TaskRouterConfig,
): RoutingDecision["factors"] {
  return candidates.map((candidate) => ({
    name: `${candidate.agent_name}.local_success_rate`,
    rawValue: round(candidate.success_rate),
    normalizedValue: round(candidate.success_rate),
    weight: round(config.weights.history),
    contribution: round(candidate.success_rate * config.weights.history),
    source: "local_history",
  }));
}

function pressureFactors(input: DecideInput): RoutingDecision["factors"] {
  const applyPressure = input.applyPressure;
  if (!applyPressure) return [];
  const staleKeys = buildPressureStaleKeys(applyPressure);
  const providers: string[] = [];
  for (const agent of input.agentRegistry) {
    const provider = providerFor(input, agent);
    if (provider !== "unknown" && !providers.includes(provider)) providers.push(provider);
  }
  return providers.flatMap((provider) => {
    const snapshots = applyPressure.snapshots.filter(
      (snapshot) => snapshot.provider === provider && !staleKeys.has(pressureSnapshotKey(snapshot)),
    );
    if (snapshots.length === 0) return [];
    const usedPct = Math.max(...snapshots.map((snapshot) => snapshot.used_pct));
    const normalized = clamp01(1 - usedPct / 100);
    // The engine currently exposes resets_at but deliberately scores pressure
    // from used_pct only. Keep that limitation visible instead of inventing
    // reset-time semantics at this orchestration layer.
    return [
      {
        name: `${provider}.subscription_pressure`,
        rawValue: round(usedPct),
        normalizedValue: round(normalized),
        weight: round(input.routerConfig.weights.quota),
        contribution: round(-((usedPct / 100) * input.routerConfig.weights.quota)),
        source: "harness" as const,
      },
    ];
  });
}

function passesPressure(input: DecideInput, agent: string): boolean {
  if (!input.applyPressure) return true;
  const provider = providerFor(input, agent);
  if (provider === "unknown") return true;
  const staleKeys = buildPressureStaleKeys(input.applyPressure);
  return !input.applyPressure.snapshots.some(
    (snapshot) =>
      snapshot.provider === provider &&
      !staleKeys.has(pressureSnapshotKey(snapshot)) &&
      (snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown"),
  );
}

function routingConfidence(profile: TaskProfile, snapshot: RouterAaSnapshot | undefined): number {
  if (!snapshot) return round(profile.confidence * 0.75);
  if (!snapshot.stale) return round(profile.confidence);
  return round(profile.confidence * 0.9);
}

function dataFreshness(snapshot: RouterAaSnapshot | undefined): Record<string, string> {
  if (!snapshot) return { artificial_analysis: "absent" };
  const normalized = normalizeSnapshot(snapshot.snapshot);
  return {
    artificial_analysis: snapshot.stale ? "stale" : "fresh",
    artificial_analysis_collected_at: normalized.collectedAt,
    ...(snapshot.ageSeconds === undefined
      ? {}
      : { artificial_analysis_age_seconds: String(snapshot.ageSeconds) }),
  };
}

function normalizeSnapshot(snapshot: RouterAaSnapshot["snapshot"]): AaModelSnapshot {
  if ("collectedAt" in snapshot) return snapshot;
  return {
    collectedAt: snapshot.provenance.collectedAt,
    dataVersion: snapshot.provenance.dataVersion,
    benchmarkVersion: snapshot.provenance.benchmarkVersion,
    models: snapshot.models,
  };
}

function stalenessAgeRatio(snapshot: RouterAaSnapshot, config: TaskRouterConfig): number {
  if (!snapshot.stale) return 0;
  const ageSeconds = snapshot.ageSeconds;
  if (ageSeconds === undefined || !Number.isFinite(ageSeconds)) return 1;
  return clamp01(ageSeconds / (3 * config.snapshot_ttl_seconds));
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function finite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegative(value: number | null | undefined): number | undefined {
  const result = finite(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
