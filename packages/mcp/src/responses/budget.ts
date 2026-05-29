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
  // text.length is in UTF-16 code units; slicing at charLimit can land between
  // the high and low halves of a surrogate pair, leaving a lone high surrogate
  // (a malformed trailing codepoint). If the last kept unit is a high
  // surrogate, back off one unit so we never split a pair. O(1).
  let end = charLimit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
