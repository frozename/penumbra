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
}

export function loadDreamConfigFromEnv(): DreamConfig {
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
  };
}
