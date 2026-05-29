export const DEFAULT_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function withinBudget(text: string, limitTokens: number): boolean {
  return estimateTokens(text) <= limitTokens;
}

export function truncateToTokens(
  text: string,
  limitTokens: number
): { text: string; truncated: boolean } {
  const charLimit = limitTokens * 4;
  if (text.length <= charLimit) return { text, truncated: false };
  return { text: text.slice(0, charLimit), truncated: true };
}
