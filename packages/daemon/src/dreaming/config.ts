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
  pc2AutoThreshold: number;
  curatorEnabled: boolean;
}

function parseNonNegativeInt(envVal: string | undefined, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;

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

function parseNonNegativeNumber(envVal: string | undefined, defaultValue: number): number {
  if (envVal === undefined) return defaultValue;

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

export function loadDreamConfigFromEnv(): DreamConfig {
  const skipPhasesRaw = process.env.PENUMBRA_DREAMING_SKIP_PHASES || '';
  const skipPhases = new Set(
    skipPhasesRaw
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0)
  );

  return {
    enabled: process.env.PENUMBRA_DREAMING_ENABLED === '1',
    cronMinutes: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_CRON_MINUTES, 30),
    perCycleUsd: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PER_CYCLE_USD, 0.50),
    dailyUsd: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_DAILY_USD, 5.00),
    pressureGuardEnabled: process.env.PENUMBRA_DREAMING_PRESSURE_GUARD !== '0',
    perCycleEmbeddingUsd: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD, 0.10),
    perCycleResearchUsd: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD, 0.25),
    linkAutoThreshold: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD, 0.75),
    p1BatchSize: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_P1_BATCH_SIZE, 10),
    retireAutoThreshold: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD, 0.85),
    contentQualityThreshold: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_CONTENT_QUALITY_THRESHOLD, 0.5),
    autoPromoteMinJudges: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES, 2),
    p4QueueMax: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_P4_QUEUE_MAX, 1000),
    reembedBatchSize: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_REEMBED_BATCH_SIZE, 100),
    skipPhases,
    eventTriggerEnabled: process.env.PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED !== '0',
    idleMinutes: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_IDLE_MINUTES, 15),
    triggerCooldownMinutes: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES, 5),
    briefRefreshHours: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS, 24),
    briefSynthMaxMemories: parseNonNegativeInt(process.env.PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES, 20),
    pc1BatchSize: (() => {
      if (process.env.PENUMBRA_DREAMING_PC1_BATCH_SIZE !== undefined) return parseNonNegativeInt(process.env.PENUMBRA_DREAMING_PC1_BATCH_SIZE, 100);
      if (process.env.PENUMBRA_DREAMING_PC1_BATCH !== undefined) { console.warn('PENUMBRA_DREAMING_PC1_BATCH is deprecated; use PENUMBRA_DREAMING_PC1_BATCH_SIZE'); return parseNonNegativeInt(process.env.PENUMBRA_DREAMING_PC1_BATCH, 100); }
      return 100;
    })(),
    pc2MinClusterSize: (() => {
      if (process.env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE !== undefined) return parseNonNegativeInt(process.env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE, 3);
      if (process.env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER !== undefined) { console.warn('PENUMBRA_DREAMING_PC2_MIN_CLUSTER is deprecated; use PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE'); return parseNonNegativeInt(process.env.PENUMBRA_DREAMING_PC2_MIN_CLUSTER, 3); }
      return 3;
    })(),
    pc2ClusterLinkThreshold: (() => {
      if (process.env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD !== undefined) return parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD, 0.85);
      if (process.env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD !== undefined) { console.warn('PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD is deprecated; use PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD'); return parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD, 0.85); }
      return 0.85;
    })(),
    pc2AutoThreshold: parseNonNegativeNumber(process.env.PENUMBRA_DREAMING_PC2_AUTO_THRESHOLD, 0.97),
    curatorEnabled: process.env.PENUMBRA_DREAMING_CURATOR_ENABLED === '1',
  };
}
