export interface TokenBudget {
  used: number;
  limit: number;
  truncated: boolean;
}

export interface EnvelopeMeta {
  token_budget?: TokenBudget;
  result_bytes?: number;
  handle_id?: string;
  deprecated?: boolean;
}

export type ContentBlock = { type: string; text?: string; [k: string]: unknown };

export interface EnvelopeResult {
  content: ContentBlock[];
  _meta: EnvelopeMeta;
  isEnvelope: true;
}

export interface EnvelopeInput {
  usedTokens: number;
  limitTokens: number;
  truncated: boolean;
  resultBytes?: number;
  handleId?: string;
}

export function makeEnvelopeResult(
  content: ContentBlock[],
  input: EnvelopeInput
): EnvelopeResult {
  return {
    content,
    _meta: {
      token_budget: {
        used: input.usedTokens,
        limit: input.limitTokens,
        truncated: input.truncated,
      },
      ...(input.resultBytes !== undefined && { result_bytes: input.resultBytes }),
      ...(input.handleId !== undefined && { handle_id: input.handleId }),
    },
    isEnvelope: true,
  };
}

export function isEnvelopeResult(v: unknown): v is EnvelopeResult {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as EnvelopeResult).isEnvelope === true
  );
}
