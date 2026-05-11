export type ValuePatternRule = {
  id: string;
  pattern: RegExp;
  /**
   * Either a plain string (passed straight to String.replace) or a
   * function that receives the full match + captured groups (same
   * shape as String.replace's function form).
   */
  replacement: string | ((match: string, ...groups: string[]) => string);
  failClosed?: boolean;
};

export type ValueRedactionHit = {
  rule_id: string;
  count: number;
};

export type RedactStringResult = {
  redacted: string;
  hits: ValueRedactionHit[];
};

export class ValuePatternRedactor {
  constructor(private readonly rules: readonly ValuePatternRule[]) {}

  redactString(text: string): RedactStringResult {
    let out = text;
    const hits: ValueRedactionHit[] = [];
    for (const rule of this.rules) {
      const matches = out.match(rule.pattern);
      if (matches?.length) {
        let actualHitCount = 0;
        if (typeof rule.replacement === 'function') {
          const fn = rule.replacement;
          out = out.replace(rule.pattern, (...args: any[]) => {
            // String.replace passes (match, p1, p2, ..., offset, str).
            // Strip the trailing offset+str so callers see (match, ...groups).
            const groups = args.slice(1, -2) as string[];
            const replaced = fn(args[0] as string, ...groups);
            if (replaced !== args[0]) actualHitCount++;
            return replaced;
          });
        } else {
          actualHitCount = matches.length;
          out = out.replace(rule.pattern, rule.replacement);
        }
        if (actualHitCount > 0) hits.push({ rule_id: rule.id, count: actualHitCount });
      }
    }
    return { redacted: out, hits };
  }

  redactValue<T>(value: T): { redacted: T; hits: ValueRedactionHit[] } {
    const accumulated: ValueRedactionHit[] = [];
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const { redacted, hits } = this.redactString(v);
        for (const h of hits) {
          const existing = accumulated.find((a) => a.rule_id === h.rule_id);
          if (existing) existing.count += h.count;
          else accumulated.push({ rule_id: h.rule_id, count: h.count });
        }
        return redacted;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
          out[k] = walk(vv);
        }
        return out;
      }
      return v;
    };
    return { redacted: walk(value) as T, hits: accumulated };
  }
}
