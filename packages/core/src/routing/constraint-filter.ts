import type { HarnessContext, TaskProfile } from "./schemas.js";

export type CandidateConstraintFacts = {
  healthy?: boolean;
  contextWindowTokens?: number;
  capabilities?: readonly string[];
  isRemote?: boolean;
  predictedCostUsd?: number;
  quotaExhausted?: boolean;
  deniedByConfig?: boolean;
};

export type HardConstraintConfig = {
  context_safety_margin_tokens?: number;
  max_predicted_cost_usd_per_dispatch?: number;
};

export type HardConstraintFilterResult = {
  admitted: string[];
  excluded: Array<{ agent: string; reasons: string[] }>;
};

/**
 * Applies non-re-admitting eligibility constraints. Unlike bias exclusions,
 * an empty result is intentional and must never be refilled with excluded candidates.
 */
export function applyHardConstraints(
  candidates: readonly string[],
  taskProfile: TaskProfile,
  harnessContext: HarnessContext,
  perCandidateFacts: Readonly<Record<string, CandidateConstraintFacts | undefined>>,
  config: HardConstraintConfig,
): HardConstraintFilterResult {
  const admitted: string[] = [];
  const excluded: Array<{ agent: string; reasons: string[] }> = [];
  const estimatedInputTokens =
    harnessContext.estimatedInputTokens ?? taskProfile.expectedInputTokens;
  const expectedOutputTokens =
    harnessContext.estimatedOutputTokens ?? taskProfile.expectedOutputTokens;
  const contextSafetyMargin = config.context_safety_margin_tokens ?? 0;

  for (const agent of candidates) {
    const facts = perCandidateFacts[agent] ?? {};
    const reasons: string[] = [];

    if (facts.healthy === false) {
      reasons.push("unhealthy_or_unavailable");
    }

    if (
      taskProfile.requiredCapabilities.length > 0 &&
      facts.capabilities !== undefined &&
      taskProfile.requiredCapabilities.some(
        (capability) => !facts.capabilities!.includes(capability),
      )
    ) {
      reasons.push("missing_required_capability_or_modality");
    }

    if (
      facts.contextWindowTokens !== undefined &&
      estimatedInputTokens !== undefined &&
      facts.contextWindowTokens <
        estimatedInputTokens + (expectedOutputTokens ?? 0) + contextSafetyMargin
    ) {
      reasons.push("context_fit");
    }

    // Privacy fails closed on unknown remoteness; other constraints keep the
    // usual fail-open-on-unknown behavior.
    if (harnessContext.localOnly === true) {
      if (facts.isRemote === true) {
        reasons.push("privacy_local_only");
      } else if (facts.isRemote === undefined) {
        reasons.push("privacy_local_only_unknown_remoteness");
      }
    }

    if (
      facts.predictedCostUsd !== undefined &&
      config.max_predicted_cost_usd_per_dispatch !== undefined &&
      facts.predictedCostUsd > config.max_predicted_cost_usd_per_dispatch
    ) {
      reasons.push("hard_budget");
    }

    if (facts.quotaExhausted === true) {
      reasons.push("quota_exhausted");
    }

    // Denial is enumerated by operator config; absence means "not denied"
    // rather than unknown here.
    if (facts.deniedByConfig === true) {
      reasons.push("denied_by_config");
    }

    if (reasons.length === 0) {
      admitted.push(agent);
    } else {
      excluded.push({ agent, reasons });
    }
  }

  return { admitted, excluded };
}
