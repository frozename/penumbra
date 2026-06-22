export interface Mention {
  target: string;
  span: { start: number; end: number };
}

const MENTION_RE = /(?<=^|\s)@([A-Za-z0-9_-]+)/g;
const RELAXED_RE = /@([A-Za-z0-9_-]+)/g;

function collectMatches(text: string, re: RegExp): Mention[] {
  const matches: Mention[] = [];
  for (const m of text.matchAll(re)) {
    const target = m[1];
    if (typeof target !== "string") continue;
    const start = m.index;
    matches.push({ target, span: { start, end: start + m[0].length } });
  }
  return matches;
}

function isEmailLikeMatch(text: string, start: number, length: number): boolean {
  if (start === 0) return false;
  const before = text[start - 1];
  if (before === undefined || !/[A-Za-z0-9]/.test(before)) return false;
  return text[start + length] === ".";
}

export function parseMentions(text: string, options?: { knownTargets?: string[] }): Mention[] {
  const strict = collectMatches(text, MENTION_RE);
  if (strict.length > 0) return strict;

  const known = options?.knownTargets;
  if (!known || known.length === 0) return strict;

  const relaxed = collectMatches(text, RELAXED_RE);
  return relaxed.filter((m) => {
    if (!known.includes(m.target)) return false;
    return !isEmailLikeMatch(text, m.span.start, m.span.end - m.span.start);
  });
}
