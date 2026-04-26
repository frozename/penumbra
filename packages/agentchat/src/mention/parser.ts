export interface Mention {
  target: string;
  span: { start: number; end: number };
}

const MENTION_RE = /(?<=^|\s)@([A-Za-z0-9_-]+)/g;

export function parseMentions(text: string, options?: { knownTargets?: string[] }): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    out.push({ target: m[1]!, span: { start, end: start + m[0].length } });
  }
  
  if (out.length === 0 && options?.knownTargets && options.knownTargets.length > 0) {
    const RELAXED_RE = /@([A-Za-z0-9_-]+)/g;
    for (const m of text.matchAll(RELAXED_RE)) {
      const target = m[1]!;
      if (options.knownTargets.includes(target)) {
        const start = m.index ?? 0;
        // reject if it looks like an email (preceded by letter/digit AND target is followed by a dot)
        // or just reject if it's an email pattern
        const isEmailLike = start > 0 && /[A-Za-z0-9]/.test(text[start - 1]!) && text[start + m[0].length] === '.';
        if (isEmailLike) {
          continue;
        }
        out.push({ target, span: { start, end: start + m[0].length } });
      }
    }
  }
  
  return out;
}
