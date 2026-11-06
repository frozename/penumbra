import { type CapsuleRefusal, refusal, type TokenReport } from "./schema.js";

export type Estimator = TokenReport["estimator"];
export type TokenCounter = (text: string) => number;

export interface TokenEstimate {
  tokens: number;
  estimator: Estimator;
}

export interface BudgetLimits {
  limit: number;
  reserve_response: number;
  reserve_tool: number;
}

export interface BudgetItem {
  id: string;
  text: string;
  essential: boolean;
  priority: number;
}

export interface AdmittedItem {
  id: string;
  tokens: number;
  essential: boolean;
}

export interface DroppedItem {
  id: string;
  tokens: number;
  reason: "budget";
}

export interface BudgetAllocation {
  ok: true;
  estimator: Estimator;
  available: number;
  used: number;
  admitted: AdmittedItem[];
  dropped: DroppedItem[];
  token_report: TokenReport;
}

export interface AllocateBudgetInput {
  limits: BudgetLimits;
  items: readonly BudgetItem[];
  counter?: TokenCounter;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function fallbackTokenEstimate(text: string): number {
  return Math.ceil(utf8ByteLength(text) / 3);
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function fallbackEstimate(text: string): TokenEstimate {
  return { tokens: fallbackTokenEstimate(text), estimator: "fallback_estimate" };
}

export function estimateTokens(text: string, counter?: TokenCounter): TokenEstimate {
  if (!counter) {
    return fallbackEstimate(text);
  }
  try {
    const tokens = counter(text);
    if (isFiniteNonNegativeInteger(tokens)) {
      return { tokens, estimator: "tokenizer" };
    }
  } catch {
    // A broken counter degrades to the fallback estimator.
  }
  return fallbackEstimate(text);
}

export function availableBudget(
  limits: BudgetLimits,
): { ok: true; available: number } | CapsuleRefusal {
  const { limit, reserve_response: reserveResponse, reserve_tool: reserveTool } = limits;
  if (!Number.isInteger(limit) || limit <= 0) {
    return refusal("invalid_budget", "limit must be a finite positive integer");
  }
  if (!isFiniteNonNegativeInteger(reserveResponse) || !isFiniteNonNegativeInteger(reserveTool)) {
    return refusal("invalid_budget", "reserves must be finite non-negative integers");
  }
  const available = limit - reserveResponse - reserveTool;
  if (available <= 0) {
    return refusal("invalid_budget", "reserves leave no available budget");
  }
  return { ok: true, available };
}

interface EstimatedItem {
  id: string;
  tokens: number;
  essential: boolean;
  priority: number;
}

function byPriorityThenId(a: EstimatedItem, b: EstimatedItem): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface FirstFitResult {
  used: number;
  admitted: AdmittedItem[];
  dropped: DroppedItem[];
}

function fitOptionals(optionals: readonly EstimatedItem[], available: number): FirstFitResult {
  const admitted: AdmittedItem[] = [];
  const dropped: DroppedItem[] = [];
  let used = 0;
  for (const item of optionals.toSorted(byPriorityThenId)) {
    if (available - used >= item.tokens) {
      used += item.tokens;
      admitted.push({ id: item.id, tokens: item.tokens, essential: false });
    } else {
      dropped.push({ id: item.id, tokens: item.tokens, reason: "budget" });
    }
  }
  return { used, admitted, dropped };
}

export function allocateBudget(input: AllocateBudgetInput): BudgetAllocation | CapsuleRefusal {
  const { limits, items, counter } = input;
  const headroom = availableBudget(limits);
  if (!headroom.ok) {
    return headroom;
  }
  const { available } = headroom;

  const estimated: EstimatedItem[] = [];
  let allTokenizer = Boolean(counter);
  for (const item of items) {
    const estimate = estimateTokens(item.text, counter);
    if (estimate.estimator !== "tokenizer") {
      allTokenizer = false;
    }
    estimated.push({
      id: item.id,
      tokens: estimate.tokens,
      essential: item.essential,
      priority: item.priority,
    });
  }
  const estimator: Estimator = allTokenizer ? "tokenizer" : "fallback_estimate";

  const essentials = estimated.filter((item) => item.essential);
  const needed = essentials.reduce((sum, item) => sum + item.tokens, 0);
  if (needed > available) {
    return refusal("essential_overflow", JSON.stringify({ needed, available }));
  }

  const admitted: AdmittedItem[] = essentials.map((item) => {
    return { id: item.id, tokens: item.tokens, essential: true };
  });
  const optionals = estimated.filter((item) => !item.essential);
  const fit = fitOptionals(optionals, available - needed);
  const used = needed + fit.used;

  return {
    ok: true,
    estimator,
    available,
    used,
    admitted: [...admitted, ...fit.admitted],
    dropped: fit.dropped,
    token_report: { estimator, used, limit: limits.limit },
  };
}

export function trimToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const maxBytes = Math.max(0, Math.floor(maxTokens)) * 3;
  let bytes = 0;
  let prefix = "";
  for (const codePoint of text) {
    const size = utf8ByteLength(codePoint);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    prefix += codePoint;
  }
  return { text: prefix, truncated: prefix.length < text.length };
}
