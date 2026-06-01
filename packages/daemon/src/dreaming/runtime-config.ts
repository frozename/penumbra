import type { Database } from "bun:sqlite";
import type { ConfigBundle } from "@penumbra/config";
import type { DreamConfig } from "./config.js";

export interface DreamRuntimeConfigResolution {
  config: DreamConfig;
  autoResumedFromHistory: boolean;
}

export function resolveDreamRuntimeConfig(
  db: Database,
  bundle: ConfigBundle,
  config: DreamConfig,
): DreamRuntimeConfigResolution {
  if (config.enabled) {
    return { config, autoResumedFromHistory: false };
  }

  if (bundle.sources.PENUMBRA_DREAMING_ENABLED === "explicit") {
    return { config, autoResumedFromHistory: false };
  }

  const historicalCronCycle = db
    .prepare(
      `SELECT 1
         FROM dream_cycles
        WHERE trigger='cron'
        LIMIT 1`,
    )
    .get();

  if (!historicalCronCycle) {
    return { config, autoResumedFromHistory: false };
  }

  return {
    config: {
      ...config,
      enabled: true,
    },
    autoResumedFromHistory: true,
  };
}
