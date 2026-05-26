import type { ConfigBundle } from '@penumbra/config';

export interface JudgePoolConfig {
  kind: 'stub' | 'real';
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
}

function parseNonNegativeInt(envVal: unknown, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;
  if (typeof envVal === 'number') {
    if (!Number.isInteger(envVal) || !Number.isFinite(envVal) || envVal < 0) {
      console.warn('dreaming env variable has invalid non-negative integer value, falling back to default', {
        value: envVal,
        defaultValue,
      });
      return defaultValue;
    }
    return envVal;
  }
  if (typeof envVal !== 'string') {
    console.warn('dreaming env variable has invalid non-negative integer value, falling back to default', {
      value: envVal,
      defaultValue,
    });
    return defaultValue;
  }

  const parsed = Number(envVal);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < 0) {
    console.warn('dreaming env variable has invalid non-negative integer value, falling back to default', {
      value: envVal,
      defaultValue,
    });
    return defaultValue;
  }

  return parsed;
}

function parseNonNegativeNumber(envVal: unknown, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;
  if (typeof envVal === 'number') {
    if (!Number.isFinite(envVal) || Number.isNaN(envVal) || envVal < 0) {
      console.warn('dreaming env variable has invalid non-negative numeric value, falling back to default', {
        value: envVal,
        defaultValue,
      });
      return defaultValue;
    }
    return envVal;
  }
  if (typeof envVal !== 'string') {
    console.warn('dreaming env variable has invalid non-negative numeric value, falling back to default', {
      value: envVal,
      defaultValue,
    });
    return defaultValue;
  }

  const parsed = Number(envVal);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    console.warn('dreaming env variable has invalid non-negative numeric value, falling back to default', {
      value: envVal,
      defaultValue,
    });
    return defaultValue;
  }

  return parsed;
}

function parseBooleanFlag(envVal: unknown): boolean {
  if (envVal === true) return true;
  return envVal === '1';
}

export function buildDreamingConfig(bundle: ConfigBundle): DreamConfig {
  const env = bundle.env as Record<string, unknown>;
  const skipPhasesRaw =
    typeof env.PENUMBRA_DREAMING_SKIP_PHASES === 'string'
      ? env.PENUMBRA_DREAMING_SKIP_PHASES
      : '';
  const skipPhases = new Set(
    skipPhasesRaw
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0)
  );

  return {
    enabled: parseBooleanFlag(env.PENUMBRA_DREAMING_ENABLED),
    cronMinutes: parseNonNegativeInt(env.PENUMBRA_DREAMING_CRON_MINUTES, 30),
    perCycleUsd: parseNonNegativeNumber(env.PENUMBRA_DREAMING_PER_CYCLE_USD, 0.50),
    dailyUsd: parseNonNegativeNumber(env.PENUMBRA_DREAMING_DAILY_USD, 5.00),
    pressureGuardEnabled: env.PENUMBRA_DREAMING_PRESSURE_GUARD !== false && env.PENUMBRA_DREAMING_PRESSURE_GUARD !== '0',
    perCycleEmbeddingUsd: parseNonNegativeNumber(env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD, 0.10),
    perCycleResearchUsd: parseNonNegativeNumber(env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD, 0.25),
    linkAutoThreshold: parseNonNegativeNumber(env.PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD, 0.75),
    p1BatchSize: parseNonNegativeInt(env.PENUMBRA_DREAMING_P1_BATCH_SIZE ?? env.PENUMBRA_DREAMING_P, 10),
    retireAutoThreshold: parseNonNegativeNumber(env.PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD, 0.85),
    contentQualityThreshold: parseNonNegativeNumber(env.PENUMBRA_DREAMING_CONTENT_QUALITY_THRESHOLD, 0.5),
    autoPromoteMinJudges: parseNonNegativeInt(env.PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES, 2),
    p4QueueMax: parseNonNegativeInt(env.PENUMBRA_DREAMING_P4_QUEUE_MAX, 1000),
    reembedBatchSize: parseNonNegativeInt(env.PENUMBRA_DREAMING_REEMBED_BATCH_SIZE, 100),
    skipPhases,
    eventTriggerEnabled:
      env.PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED !== false &&
      env.PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED !== '0',
    idleMinutes: parseNonNegativeInt(env.PENUMBRA_DREAMING_IDLE_MINUTES, 15),
    triggerCooldownMinutes: parseNonNegativeInt(env.PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES, 5),
    briefRefreshHours: parseNonNegativeInt(env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS, 24),
    briefSynthMaxMemories: parseNonNegativeInt(env.PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES, 20),
    pc1BatchSize: (() => {
      if (env.PENUMBRA_DREAMING_PC1_BATCH_SIZE !== undefined) {
        return parseNonNegativeInt(env.PENUMBRA_DREAMING_PC1_BATCH_SIZE, 100);
      }
      if (env.PENUMBRA_DREAMING_PC1_BATCH !== undefined) {
        console.warn('PENUMBRA_DREAMING_PC1_BATCH is deprecated; use PENUMBRA_DREAMING_PC1_BATCH_SIZE');
        return parseNonNegativeInt(env.PENUMBRA_DREAMING_PC1_BATCH, 100);
      }
      if (env.PENUMBRA_DREAMING_PC !== undefined) {
        return parseNonNegativeInt(env.PENUMBRA_DREAMING_PC, 100);
      }
      return 100;
    })(),
    pc2MinClusterSize: (() => {
      if (env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE !== undefined) {
        return parseNonNegativeInt(env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE, 3);
      }
      if (env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER !== undefined) {
        console.warn('PENUMBRA_DREAMING_PC2_MIN_CLUSTER is deprecated; use PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE');
        return parseNonNegativeInt(env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER, 3);
      }
      return 3;
    })(),
    pc2ClusterLinkThreshold: (() => {
      if (env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD !== undefined) {
        return parseNonNegativeNumber(env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD, 0.85);
      }
      if (env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD !== undefined) {
        console.warn(
          'PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD is deprecated; use PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD'
        );
        return parseNonNegativeNumber(env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD, 0.85);
      }
      return 0.85;
    })(),
    pc2AutoThreshold: parseNonNegativeNumber(env.PENUMBRA_DREAMING_PC2_AUTO_THRESHOLD, 0.97),
    negativeCacheTtlMs: parseNonNegativeInt(
      env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS,
      86_400_000
    ),
    curatorEnabled: parseBooleanFlag(env.PENUMBRA_DREAMING_CURATOR_ENABLED),
    rewriterEnabled: parseBooleanFlag(env.PENUMBRA_DREAMING_REWRITER_ENABLED),
    rewriterBaseUrl: String(env.PENUMBRA_DREAMING_REWRITER_BASE_URL ?? 'http://127.0.0.1:7944'),
    rewriterModel: String(env.PENUMBRA_DREAMING_REWRITER_MODEL ?? 'Qwen3.6-35B-A3B-4bit'),
    rewriterTimeoutMs: parseNonNegativeInt(env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS, 5000),
    rewriterCacheTtlMs: parseNonNegativeInt(
      env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS,
      30 * 86_400_000,
    ),
    rewriterConcurrency: parseNonNegativeInt(env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY, 4),
  };
}
