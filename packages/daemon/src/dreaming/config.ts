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
  p4QueueMax?: number;
  judgePool?: JudgePoolConfig;
  reembedBatchSize: number;
  skipPhases: Set<string>;
  eventTriggerEnabled: boolean;
  idleMinutes: number;
  triggerCooldownMinutes: number;
  briefRefreshHours: number;
  briefSynthMaxMemories?: number;
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
    cronMinutes: process.env.PENUMBRA_DREAMING_CRON_MINUTES
      ? Number(process.env.PENUMBRA_DREAMING_CRON_MINUTES)
      : 30,
    perCycleUsd: process.env.PENUMBRA_DREAMING_PER_CYCLE_USD
      ? Number(process.env.PENUMBRA_DREAMING_PER_CYCLE_USD)
      : 0.50,
    dailyUsd: process.env.PENUMBRA_DREAMING_DAILY_USD
      ? Number(process.env.PENUMBRA_DREAMING_DAILY_USD)
      : 5.00,
    pressureGuardEnabled: process.env.PENUMBRA_DREAMING_PRESSURE_GUARD !== '0',
    perCycleEmbeddingUsd: process.env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD
      ? Number(process.env.PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD)
      : 0.10,
    perCycleResearchUsd: process.env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD
      ? Number(process.env.PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD)
      : 0.25,
    linkAutoThreshold: process.env.PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD
      ? Number(process.env.PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD)
      : 0.75,
    p1BatchSize: process.env.PENUMBRA_DREAMING_P1_BATCH_SIZE
      ? Number(process.env.PENUMBRA_DREAMING_P1_BATCH_SIZE)
      : 10,
    retireAutoThreshold: process.env.PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD
      ? Number(process.env.PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD)
      : 0.85,
    autoPromoteMinJudges: process.env.PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES
      ? Number(process.env.PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES)
      : 2,
    p4QueueMax: process.env.PENUMBRA_DREAMING_P4_QUEUE_MAX
      ? Number(process.env.PENUMBRA_DREAMING_P4_QUEUE_MAX)
      : 1000,
    reembedBatchSize: process.env.PENUMBRA_DREAMING_REEMBED_BATCH_SIZE
      ? Number(process.env.PENUMBRA_DREAMING_REEMBED_BATCH_SIZE)
      : 100,
    skipPhases,
    eventTriggerEnabled: process.env.PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED !== '0',
    idleMinutes: process.env.PENUMBRA_DREAMING_IDLE_MINUTES
      ? Number(process.env.PENUMBRA_DREAMING_IDLE_MINUTES)
      : 15,
    triggerCooldownMinutes: process.env.PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES
      ? Number(process.env.PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES)
      : 5,
    briefRefreshHours: process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS
      ? Number(process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS)
      : 24,
    briefSynthMaxMemories: process.env.PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES
      ? Number(process.env.PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES)
      : 20,
  };
}
