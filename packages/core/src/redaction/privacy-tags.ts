const OPEN = "<private>";
const CLOSE = "</private>";

type SkipResult = { ok: true; end: number } | { ok: false };

function skipPrivateBlock(text: string, blockStart: number): SkipResult {
  let depth = 1;
  let j = blockStart + OPEN.length;
  while (depth > 0) {
    const nextOpen = text.indexOf(OPEN, j);
    const nextClose = text.indexOf(CLOSE, j);
    if (nextClose === -1) return { ok: false };
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      j = nextOpen + OPEN.length;
    } else {
      depth--;
      j = nextClose + CLOSE.length;
    }
  }
  return { ok: true, end: j };
}

export function stripPrivacyTags(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf(OPEN, i);
    if (openIdx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, openIdx);
    const skip = skipPrivateBlock(text, openIdx);
    if (!skip.ok) return result;
    i = skip.end;
  }
  return result;
}
