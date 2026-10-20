import type { z } from "zod";

import { type LlmServingCandidate, tryResolveLlmProvider } from "@penumbra/core";

import type { LlmInvokeInput, LlmInvokeResult } from "../services/llm-invoke.js";

const NO_ELIGIBLE_REWRITE_CANDIDATE = "no_eligible_candidate";

interface NoEligibleCandidateFailure {
  ok: false;
  reason: typeof NO_ELIGIBLE_REWRITE_CANDIDATE;
  failureMessage: string;
  candidate: LlmServingCandidate;
  failures?: undefined;
}

export type RewriteInvokeResult<T extends z.ZodType> =
  | LlmInvokeResult<T>
  | NoEligibleCandidateFailure;

// llmInvoke reports transport and parse failures as values but rejects when
// candidate resolution leaves nothing to call: every seat excluded by an active
// routing bias, or a seat whose provider is outside the allowlist. For the P4
// rewriter that is a seat failure to record, not a reason to abort the cycle.
export async function invokeRewriter<T extends z.ZodType>(
  invoke: (input: LlmInvokeInput<T>) => Promise<LlmInvokeResult<T>>,
  input: LlmInvokeInput<T>,
): Promise<RewriteInvokeResult<T>> {
  try {
    return await invoke(input);
  } catch (err) {
    return {
      ok: false,
      reason: NO_ELIGIBLE_REWRITE_CANDIDATE,
      failureMessage: err instanceof Error ? err.message : String(err),
      candidate: requestedPrimary(input),
    };
  }
}

export function noEligibleCandidateMessage(failure: {
  reason: string;
  failureMessage: string;
}): string | undefined {
  return failure.reason === NO_ELIGIBLE_REWRITE_CANDIDATE ? failure.failureMessage : undefined;
}

function requestedPrimary<T extends z.ZodType>(input: LlmInvokeInput<T>): LlmServingCandidate {
  return {
    name: input.candidateName ?? input.model,
    baseUrl: input.baseUrl,
    model: input.model,
    provider: tryResolveLlmProvider(input.baseUrl, input.provider) ?? "unknown",
    authSource: input.auth?.source ?? "none",
    tier: "primary",
  };
}
