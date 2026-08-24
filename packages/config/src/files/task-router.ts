import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { deepFreeze, loaderError } from "./_loader-util.js";
import { existsPath, readUtf8 } from "./node-fs.js";

const DEFAULT_WEIGHTS = {
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
};

const DEFAULT_THRESHOLDS = {
  quality_floor: 0.5,
  context_safety_margin_tokens: 4096,
  max_fallbacks: 2,
  judge_confidence_floor: 0.6,
};

const TaskRouterWeightsSchema = z
  .object({
    quality: z.number().min(0).default(DEFAULT_WEIGHTS.quality),
    speed: z.number().min(0).default(DEFAULT_WEIGHTS.speed),
    latency: z.number().min(0).default(DEFAULT_WEIGHTS.latency),
    cost: z.number().min(0).default(DEFAULT_WEIGHTS.cost),
    reliability: z.number().min(0).default(DEFAULT_WEIGHTS.reliability),
    affinity: z.number().min(0).default(DEFAULT_WEIGHTS.affinity),
    history: z.number().min(0).default(DEFAULT_WEIGHTS.history),
    quota: z.number().min(0).default(DEFAULT_WEIGHTS.quota),
    uncertainty: z.number().min(0).default(DEFAULT_WEIGHTS.uncertainty),
    staleness: z.number().min(0).default(DEFAULT_WEIGHTS.staleness),
  })
  .strict()
  .default(DEFAULT_WEIGHTS);

const TaskRouterThresholdsSchema = z
  .object({
    quality_floor: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.quality_floor),
    context_safety_margin_tokens: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_THRESHOLDS.context_safety_margin_tokens),
    max_fallbacks: z.number().int().min(0).default(DEFAULT_THRESHOLDS.max_fallbacks),
    judge_confidence_floor: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_THRESHOLDS.judge_confidence_floor),
  })
  .strict()
  .default(DEFAULT_THRESHOLDS);

export const TaskRouterConfigSchema = z
  .object({
    mode: z.enum(["off", "recommend", "shadow", "auto"]).default("off"),
    weights: TaskRouterWeightsSchema,
    thresholds: TaskRouterThresholdsSchema,
    snapshot_ttl_seconds: z.number().int().positive().default(86400),
    max_predicted_cost_usd_per_dispatch: z.number().min(0).optional(),
  })
  .strict();
export type TaskRouterConfig = z.infer<typeof TaskRouterConfigSchema>;

export function loadTaskRouterConfigFromDir(dir: string): TaskRouterConfig {
  const filePath = join(resolve(dir), "router.yaml");

  try {
    // Own duplicate-key rejection here rather than inheriting the YAML library's default.
    const parsed: unknown = existsPath(filePath)
      ? (parseYaml(readUtf8(filePath), { uniqueKeys: true }) ?? {})
      : {};
    return deepFreeze(TaskRouterConfigSchema.parse(parsed));
  } catch (error) {
    throw loaderError(filePath, error);
  }
}
