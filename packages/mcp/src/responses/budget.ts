export const DEFAULT_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function withinBudget(text: string, limitTokens: number): boolean {
  return estimateTokens(text) <= limitTokens;
}

export function truncateToTokens(
  text: string,
  limitTokens: number,
): { text: string; truncated: boolean } {
  const charLimit = limitTokens * 4;
  if (text.length <= charLimit) return { text, truncated: false };
  return { text: sliceSurrogateSafe(text, charLimit), truncated: true };
}

/**
 * Slice `text` to at most `maxChars` UTF-16 code units without splitting a
 * surrogate pair. String lengths count UTF-16 code units, so a naive slice can
 * land between the high and low halves of a surrogate pair, leaving a lone
 * high surrogate (a malformed trailing codepoint that strict JSON decoders
 * reject). If the last kept unit is a high surrogate, back off one unit so we
 * never split a pair. O(1).
 */
export function sliceSurrogateSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
