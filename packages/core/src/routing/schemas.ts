import { z } from "zod";

const UnitIntervalSchema = z.number().min(0).max(1);
const NonNegativeIntSchema = z.number().int().nonnegative();

export const RoutingTaskTypeSchema = z.enum([
  "coding",
  "debugging",
  "code_review",
  "architecture",
  "agentic",
  "research",
  "analysis",
  "writing",
  "summarization",
  "multimodal",
  "tool_use",
  "other",
]);
export type RoutingTaskType = z.infer<typeof RoutingTaskTypeSchema>;

export const TaskProfileSchema = z
  .object({
    schemaVersion: z.literal("1"),
    taskTypes: z.array(RoutingTaskTypeSchema),
    complexity: UnitIntervalSchema,
    risk: UnitIntervalSchema,
    ambiguity: UnitIntervalSchema,
    codingDemand: UnitIntervalSchema,
    reasoningDemand: UnitIntervalSchema,
    agenticDemand: UnitIntervalSchema,
    contextDemand: UnitIntervalSchema,
    latencySensitivity: UnitIntervalSchema,
    costSensitivity: UnitIntervalSchema,
    reliabilityDemand: UnitIntervalSchema,
    expectedInputTokens: NonNegativeIntSchema.optional(),
    expectedOutputTokens: NonNegativeIntSchema.optional(),
    requiredCapabilities: z.array(z.string()),
    preferredCapabilities: z.array(z.string()),
    disallowedCapabilities: z.array(z.string()),
    confidence: UnitIntervalSchema,
    rationale: z.array(z.string()),
  })
  .strict();
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export const HarnessContextSchema = z
  .object({
    availableAgents: z.array(z.string()).optional(),
    promptChars: NonNegativeIntSchema.optional(),
    estimatedInputTokens: NonNegativeIntSchema.optional(),
    estimatedOutputTokens: NonNegativeIntSchema.optional(),
    taskClass: z.string().optional(),
    projectId: z.string().optional(),
    dispatchKind: z.string().optional(),
    role: z.string().optional(),
    localOnly: z.boolean().optional(),
    subscriptionQuota: z
      .object({
        remainingPct: UnitIntervalSchema.optional(),
        resetsAtIso: z.string().optional(),
        consumptionRatePerHour: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    marginalCashCostUsd: z
      .object({
        inputUsd: z.number().nonnegative().optional(),
        outputUsd: z.number().nonnegative().optional(),
        totalUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HarnessContext = z.infer<typeof HarnessContextSchema>;

export const RoutingFactorSourceSchema = z.enum([
  "artificial_analysis",
  "harness",
  "local_history",
  "config",
]);
export type RoutingFactorSource = z.infer<typeof RoutingFactorSourceSchema>;

export const RoutingDecisionSchema = z
  .object({
    selected: z
      .object({
        agent: z.string(),
        provider: z.string(),
        reasoningLevel: z.string().optional(),
        routeId: z.string(),
      })
      .strict()
      .nullable(),
    taskProfile: TaskProfileSchema,
    score: z.number(),
    confidence: UnitIntervalSchema,
    alternatives: z.array(
      z
        .object({
          routeId: z.string(),
          score: z.number().optional(),
          excluded: z.boolean(),
          reasons: z.array(z.string()),
        })
        .strict(),
    ),
    factors: z.array(
      z
        .object({
          name: z.string(),
          rawValue: z.union([z.number(), z.string()]).optional(),
          normalizedValue: z.number().optional(),
          weight: z.number().optional(),
          contribution: z.number().optional(),
          source: RoutingFactorSourceSchema,
        })
        .strict(),
    ),
    fallbackChain: z.array(z.string()),
    dataFreshness: z.record(z.string(), z.string()),
    explanation: z.array(z.string()),
    routerSchemaVersion: z.string(),
  })
  .strict();
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

// AA API schemas stay non-strict because upstream may add fields without notice.
export const AaEvaluationSchema = z.object({
  artificial_analysis_intelligence_index: z.number().nullable().optional(),
  artificial_analysis_coding_index: z.number().nullable().optional(),
  artificial_analysis_math_index: z.number().nullable().optional(),
  mmlu_pro: z.number().nullable().optional(),
  gpqa: z.number().nullable().optional(),
  hle: z.number().nullable().optional(),
  livecodebench: z.number().nullable().optional(),
  scicode: z.number().nullable().optional(),
  math_500: z.number().nullable().optional(),
  aime: z.number().nullable().optional(),
});
export type AaEvaluation = z.infer<typeof AaEvaluationSchema>;

export const AaPricingSchema = z.object({
  price_1m_blended_3_to_1: z.number().nullable().optional(),
  price_1m_input_tokens: z.number().nullable().optional(),
  price_1m_output_tokens: z.number().nullable().optional(),
});
export type AaPricing = z.infer<typeof AaPricingSchema>;

export const AaModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  model_creator: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  evaluations: AaEvaluationSchema,
  pricing: AaPricingSchema,
  median_output_tokens_per_second: z.number().nullable().optional(),
  median_time_to_first_token_seconds: z.number().nullable().optional(),
  median_time_to_first_answer_token: z.number().nullable().optional(),
});
export type AaModel = z.infer<typeof AaModelSchema>;

export const AaModelSnapshotSchema = z.object({
  collectedAt: z.string(),
  dataVersion: z.string().optional(),
  benchmarkVersion: z.string().optional(),
  models: z.array(AaModelSchema),
});
export type AaModelSnapshot = z.infer<typeof AaModelSnapshotSchema>;
