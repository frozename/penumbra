const OPEN = "<private>";
const CLOSE = "</private>";

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
    let depth = 1;
    let j = openIdx + OPEN.length;
    while (depth > 0) {
      const nextOpen = text.indexOf(OPEN, j);
      const nextClose = text.indexOf(CLOSE, j);
      if (nextClose === -1) {
        return result;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        j = nextOpen + OPEN.length;
      } else {
        depth--;
        j = nextClose + CLOSE.length;
      }
    }
    i = j;
  }
  return result;
}
