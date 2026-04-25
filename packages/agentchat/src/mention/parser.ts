export interface Mention {
  target: string;
  span: { start: number; end: number };
}

const MENTION_RE = /(?<=^|\s)@([A-Za-z0-9_-]+)/g;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    out.push({ target: m[1]!, span: { start, end: start + m[0].length } });
  }
  return out;
}
