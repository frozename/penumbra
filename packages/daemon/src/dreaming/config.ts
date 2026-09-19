import type { ConfigBundle } from "@penumbra/config";

export const DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES = 2;

export interface JudgePoolConfig {
  kind: "stub" | "real";
}

export interface DreamPhaseBudgetFractions {
  llm: number;
  embedding: number;
  research: number;
}

export interface DreamPhaseCostEstimatesUsd {
  p3ScorerLlmUsd: number;
  p4RewriterLlmUsd: number;
  p5ResearchUsd: number;
  p6BriefSynthLlmUsd: number;
  p7EmbedUsd: number;
  p1JevShadowUsd?: number;
}

// Covers one full 64,000-token Jev request: 64,000 × $0.042 / 1e6 = $0.002688.
export const DEFAULT_P1_JEV_SHADOW_ESTIMATE_USD = 0.003;

export function resolveP1JevShadowEstimateUsd(estimates?: DreamPhaseCostEstimatesUsd): number {
  const configured = estimates?.p1JevShadowUsd;
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_P1_JEV_SHADOW_ESTIMATE_USD;
}

// The parsed PENUMBRA_TYPESAFE_* slice, typed exactly as Phase 2's
// TypesafeEnvInput so the dreaming config can hand it to
// resolveTypesafeSettings unchanged.
export interface TypesafeEnvSlice {
  readonly PENUMBRA_TYPESAFE_API_KEY?: string | undefined;
  readonly PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN?: string | undefined;
  readonly PENUMBRA_TYPESAFE_BASE_URL: string;
  readonly PENUMBRA_TYPESAFE_MODEL: string;
  readonly PENUMBRA_TYPESAFE_TIMEOUT_MS: number;
  readonly PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "off" | "shadow";
}

function nonNegIntOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegNumOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface DreamConfig {
  enabled: boolean;
  cronMinutes: number;
  perCycleUsd: number;
  dailyUsd: number;
  pressureGuardEnabled: boolean;
  perCycleEmbeddingUsd: number;
  perCycleResearchUsd: number;
  linkAutoThreshold: number;
  p1BatchSize: number;
  t2PromotionMinEvents?: number;
  retireAutoThreshold?: number;
  autoPromoteMinJudges?: number;
  contentQualityThreshold: number;
  p4QueueMax?: number;
  judgePool?: JudgePoolConfig;
  reembedBatchSize: number;
  skipPhases: Set<string>;
  eventTriggerEnabled: boolean;
  idleMinutes: number;
  triggerCooldownMinutes: number;
  briefRefreshHours: number;
  briefSynthMaxMemories?: number;
  pc1BatchSize: number;
  pc2MinClusterSize: number;
  pc2ClusterLinkThreshold: number;
  /**
   * Auto-apply score threshold for PC2 intra-cluster links.
   * Legacy 2.0 values are effectively disabled (never auto-applies); 0.97 restores
   * expected behavior while keeping operator control in PENUMBRA_DREAMING_PC2_AUTO_APPLY.
   */
  pc2AutoThreshold: number;
  curatorEnabled: boolean;
  negativeCacheTtlMs?: number;
  rewriterEnabled: boolean;
  rewriterBaseUrl: string;
  rewriterModel: string;
  rewriterTimeoutMs: number;
  rewriterCacheTtlMs: number;
  rewriterConcurrency: number;
  phaseBudgetFractions?: DreamPhaseBudgetFractions;
  phaseCostEstimatesUsd?: DreamPhaseCostEstimatesUsd;
  typesafeJudgePromotion?: "off" | "shadow";
  typesafeEnv?: TypesafeEnvSlice;
}

// Local typed view of the dreaming slice of EnvConfig (config-refactor F16):
// remove this assertion once @penumbra/config's EnvSchema preserves per-key types
// via a single `z.object({…})` declaration (currently the schema is assembled at
// runtime from ENV_REGISTRY, which loses inference).
interface DreamingEnvSlice {
  PENUMBRA_DREAMING_ENABLED: boolean;
  PENUMBRA_DREAMING_CRON_MINUTES: number;
  PENUMBRA_DREAMING_PER_CYCLE_USD: number;
  PENUMBRA_DREAMING_DAILY_USD: number;
  PENUMBRA_DREAMING_PRESSURE_GUARD: boolean;
  PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD: number;
  PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD: number;
  PENUMBRA_DREAMING_PHASE_LLM_FRACTION: number | undefined;
  PENUMBRA_DREAMING_PHASE_EMBEDDING_FRACTION: number | undefined;
  PENUMBRA_DREAMING_PHASE_RESEARCH_FRACTION: number | undefined;
  PENUMBRA_DREAMING_COST_ESTIMATE_P3_LLM_USD: number;
  PENUMBRA_DREAMING_COST_ESTIMATE_P4_REWRITER_LLM_USD: number;
  PENUMBRA_DREAMING_COST_ESTIMATE_P5_RESEARCH_USD: number;
  PENUMBRA_DREAMING_COST_ESTIMATE_P6_SYNTH_LLM_USD: number;
  PENUMBRA_DREAMING_COST_ESTIMATE_P7_EMBED_USD: number;
  PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD: number;
  PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD: number;
  PENUMBRA_DREAMING_P1_BATCH_SIZE: number | undefined;
  PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS: number;
  PENUMBRA_DREAMING_P: number | undefined;
  PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD: number;
  PENUMBRA_DREAMING_CONTENT_QUALITY_THRESHOLD: number;
  PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES: number;
  PENUMBRA_DREAMING_P4_QUEUE_MAX: number;
  PENUMBRA_DREAMING_REEMBED_BATCH_SIZE: number;
  PENUMBRA_DREAMING_SKIP_PHASES: string;
  PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED: boolean;
  PENUMBRA_DREAMING_IDLE_MINUTES: number;
  PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES: number;
  PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS: number;
  PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES: number;
  PENUMBRA_DREAMING_PC1_BATCH_SIZE: number | undefined;
  PENUMBRA_DREAMING_PC1_BATCH: number | undefined;
  PENUMBRA_DREAMING_PC: number | undefined;
  PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE: number | undefined;
  PENUMBRA_DREAMING_PC2_MIN_CLUSTER: number | undefined;
  PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD: number | undefined;
  PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD: number | undefined;
  PENUMBRA_DREAMING_PC2_AUTO_THRESHOLD: number;
  PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS: number;
  PENUMBRA_DREAMING_CURATOR_ENABLED: boolean;
  PENUMBRA_DREAMING_REWRITER_ENABLED: boolean;
  PENUMBRA_DREAMING_REWRITER_BASE_URL: string;
  PENUMBRA_DREAMING_REWRITER_MODEL: string;
  PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS: number;
  PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS: number;
  PENUMBRA_DREAMING_REWRITER_CONCURRENCY: number;
  PENUMBRA_TYPESAFE_API_KEY: string | undefined;
  PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: string | undefined;
  PENUMBRA_TYPESAFE_BASE_URL: string;
  PENUMBRA_TYPESAFE_MODEL: string;
  PENUMBRA_TYPESAFE_TIMEOUT_MS: number;
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "off" | "shadow";
}

function typesafeEnvSlice(env: DreamingEnvSlice): TypesafeEnvSlice {
  return {
    PENUMBRA_TYPESAFE_API_KEY: env.PENUMBRA_TYPESAFE_API_KEY,
    PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: env.PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN,
    PENUMBRA_TYPESAFE_BASE_URL: env.PENUMBRA_TYPESAFE_BASE_URL,
    PENUMBRA_TYPESAFE_MODEL: env.PENUMBRA_TYPESAFE_MODEL,
    PENUMBRA_TYPESAFE_TIMEOUT_MS: env.PENUMBRA_TYPESAFE_TIMEOUT_MS,
    PENUMBRA_TYPESAFE_JUDGE_PROMOTION: env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION,
  };
}

export function buildDreamingConfig(bundle: ConfigBundle): DreamConfig {
  const env = bundle.env as unknown as DreamingEnvSlice;
  const t2PromotionMinEventsRaw = env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS;
  const skipPhases = new Set(
    env.PENUMBRA_DREAMING_SKIP_PHASES.split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  );

  if (
    env.PENUMBRA_DREAMING_PC1_BATCH !== undefined &&
    env.PENUMBRA_DREAMING_PC1_BATCH_SIZE === undefined
  ) {
    console.warn("PENUMBRA_DREAMING_PC1_BATCH is deprecated; use PENUMBRA_DREAMING_PC1_BATCH_SIZE");
  }
  if (
    env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER !== undefined &&
    env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE === undefined
  ) {
    console.warn(
      "PENUMBRA_DREAMING_PC2_MIN_CLUSTER is deprecated; use PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE",
    );
  }
  if (
    env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD !== undefined &&
    env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD === undefined
  ) {
    console.warn(
      "PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD is deprecated; use PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD",
    );
  }

  const perCycleUsd = env.PENUMBRA_DREAMING_PER_CYCLE_USD;
  const defaultEmbeddingFraction =
    perCycleUsd > 0
      ? Math.min(1, Math.max(0, env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD / perCycleUsd))
      : 0;
  const defaultResearchFraction =
    perCycleUsd > 0
      ? Math.min(1, Math.max(0, env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD / perCycleUsd))
      : 0;
  const configuredEmbeddingFraction =
    env.PENUMBRA_DREAMING_PHASE_EMBEDDING_FRACTION ?? defaultEmbeddingFraction;
  const configuredResearchFraction =
    env.PENUMBRA_DREAMING_PHASE_RESEARCH_FRACTION ?? defaultResearchFraction;
  const configuredLlmFraction =
    env.PENUMBRA_DREAMING_PHASE_LLM_FRACTION ??
    Math.max(0, 1 - configuredEmbeddingFraction - configuredResearchFraction);

  const rawBudgetFractions = {
    llm: Math.max(0, configuredLlmFraction),
    embedding: Math.max(0, configuredEmbeddingFraction),
    research: Math.max(0, configuredResearchFraction),
  };
  const rawFractionTotal =
    rawBudgetFractions.llm + rawBudgetFractions.embedding + rawBudgetFractions.research;
  const phaseBudgetFractions =
    rawFractionTotal > 0
      ? {
          llm: rawBudgetFractions.llm / rawFractionTotal,
          embedding: rawBudgetFractions.embedding / rawFractionTotal,
          research: rawBudgetFractions.research / rawFractionTotal,
        }
      : { llm: 1, embedding: 0, research: 0 };

  return {
    enabled: env.PENUMBRA_DREAMING_ENABLED,
    cronMinutes: env.PENUMBRA_DREAMING_CRON_MINUTES,
    perCycleUsd: env.PENUMBRA_DREAMING_PER_CYCLE_USD,
    dailyUsd: env.PENUMBRA_DREAMING_DAILY_USD,
    pressureGuardEnabled: env.PENUMBRA_DREAMING_PRESSURE_GUARD,
    perCycleEmbeddingUsd: env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD,
    perCycleResearchUsd: env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD,
    linkAutoThreshold: env.PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD,
    p1BatchSize: nonNegIntOr(env.PENUMBRA_DREAMING_P1_BATCH_SIZE ?? env.PENUMBRA_DREAMING_P, 10),
    t2PromotionMinEvents: nonNegIntOr(t2PromotionMinEventsRaw, 5),
    retireAutoThreshold: env.PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD,
    contentQualityThreshold: env.PENUMBRA_DREAMING_CONTENT_QUALITY_THRESHOLD,
    autoPromoteMinJudges: env.PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES,
    p4QueueMax: env.PENUMBRA_DREAMING_P4_QUEUE_MAX,
    reembedBatchSize: env.PENUMBRA_DREAMING_REEMBED_BATCH_SIZE,
    skipPhases,
    eventTriggerEnabled: env.PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED,
    idleMinutes: env.PENUMBRA_DREAMING_IDLE_MINUTES,
    triggerCooldownMinutes: env.PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES,
    briefRefreshHours: env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS,
    briefSynthMaxMemories: env.PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES,
    pc1BatchSize: nonNegIntOr(
      env.PENUMBRA_DREAMING_PC1_BATCH_SIZE ??
        env.PENUMBRA_DREAMING_PC1_BATCH ??
        env.PENUMBRA_DREAMING_PC,
      100,
    ),
    pc2MinClusterSize: nonNegIntOr(
      env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE ?? env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER,
      3,
    ),
    pc2ClusterLinkThreshold: nonNegNumOr(
      env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD ?? env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD,
      0.85,
    ),
    pc2AutoThreshold: env.PENUMBRA_DREAMING_PC2_AUTO_THRESHOLD,
    negativeCacheTtlMs: env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS,
    curatorEnabled: env.PENUMBRA_DREAMING_CURATOR_ENABLED,
    rewriterEnabled: env.PENUMBRA_DREAMING_REWRITER_ENABLED,
    rewriterBaseUrl: env.PENUMBRA_DREAMING_REWRITER_BASE_URL,
    rewriterModel: env.PENUMBRA_DREAMING_REWRITER_MODEL,
    rewriterTimeoutMs: env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS,
    rewriterCacheTtlMs: env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS,
    rewriterConcurrency: env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY,
    phaseBudgetFractions,
    phaseCostEstimatesUsd: {
      p3ScorerLlmUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P3_LLM_USD,
      p4RewriterLlmUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P4_REWRITER_LLM_USD,
      p5ResearchUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P5_RESEARCH_USD,
      p6BriefSynthLlmUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P6_SYNTH_LLM_USD,
      p7EmbedUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P7_EMBED_USD,
      p1JevShadowUsd: env.PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD,
    },
    typesafeJudgePromotion: env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION === "shadow" ? "shadow" : "off",
    typesafeEnv: typesafeEnvSlice(env),
  };
}
