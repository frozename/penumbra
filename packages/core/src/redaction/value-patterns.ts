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

export type RedactValueLimits = {
  maxDepth?: number;
  maxStringBytes?: number;
};

export type RedactValueResult<T> = {
  redacted: T;
  hits: ValueRedactionHit[];
  rewritten: boolean;
};

export const MAX_WALKER_DEPTH = 16;
export const MAX_WALKER_STRING_BYTES = 64 * 1024;
export const WALKER_DEPTH_EXCEEDED_RULE_ID = "walker_depth_exceeded";
export const WALKER_STRING_OVERSIZE_RULE_ID = "walker_string_oversize";
export const WALKER_KEY_COLLISION_RULE_ID = "walker_key_collision";

function mergeHits(into: Map<string, number>, hits: ValueRedactionHit[]): void {
  for (const h of hits) {
    into.set(h.rule_id, (into.get(h.rule_id) ?? 0) + h.count);
  }
}

function addSyntheticHit(into: Map<string, number>, ruleId: string): void {
  into.set(ruleId, (into.get(ruleId) ?? 0) + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  return encoded.subarray(0, maxBytes).toString("utf8");
}

export class ValuePatternRedactor {
  constructor(private readonly rules: readonly ValuePatternRule[]) {}

  redactString(text: string): RedactStringResult {
    let out = text;
    const hits: ValueRedactionHit[] = [];
    for (const rule of this.rules) {
      const matches = out.match(rule.pattern);
      if (matches?.length) {
        let actualHitCount = 0;
        if (typeof rule.replacement === "function") {
          const fn = rule.replacement;
          out = out.replace(rule.pattern, (...args: unknown[]) => {
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

  redactValue<T>(value: T, limits: RedactValueLimits = {}): RedactValueResult<T> {
    const maxDepth = limits.maxDepth ?? MAX_WALKER_DEPTH;
    const maxStringBytes = limits.maxStringBytes ?? MAX_WALKER_STRING_BYTES;
    const hitCounts = new Map<string, number>();
    let depthExceededRecorded = false;
    let oversizeRecorded = false;

    const walk = (input: unknown, depth: number): { value: unknown; rewritten: boolean } => {
      if (depth > maxDepth) {
        if (!depthExceededRecorded) {
          addSyntheticHit(hitCounts, WALKER_DEPTH_EXCEEDED_RULE_ID);
          depthExceededRecorded = true;
        }
        return { value: input, rewritten: false };
      }

      if (typeof input === "string") {
        const bytes = Buffer.byteLength(input, "utf8");
        if (bytes > maxStringBytes) {
          if (!oversizeRecorded) {
            addSyntheticHit(hitCounts, WALKER_STRING_OVERSIZE_RULE_ID);
            oversizeRecorded = true;
          }
          const sampled = utf8Prefix(input, maxStringBytes);
          const result = this.redactString(sampled);
          mergeHits(hitCounts, result.hits);
          // Oversized strings are sampled for audit/blocking only; preserve original bytes.
          return { value: input, rewritten: false };
        }

        const result = this.redactString(input);
        mergeHits(hitCounts, result.hits);
        if (result.redacted === input) {
          return { value: input, rewritten: false };
        }
        return { value: result.redacted, rewritten: true };
      }

      if (Array.isArray(input)) {
        let out: unknown[] | null = null;
        let anyRewritten = false;
        for (let i = 0; i < input.length; i++) {
          const next = walk(input[i], depth + 1);
          if (next.rewritten) {
            if (!out) out = input.slice();
            out[i] = next.value;
            anyRewritten = true;
          }
        }
        if (!anyRewritten) return { value: input, rewritten: false };
        return { value: out as unknown, rewritten: true };
      }

      if (isPlainObject(input)) {
        let anyRewritten = false;
        const rewrittenEntries: Array<{ key: string; value: unknown }> = [];
        const keyOccurrences = new Map<string, number>();
        for (const [k, v] of Object.entries(input)) {
          const keyNext = walk(k, depth + 1);
          const nextKey = String(keyNext.value);
          const next = walk(v, depth + 1);
          const occurrence = (keyOccurrences.get(nextKey) ?? 0) + 1;
          keyOccurrences.set(nextKey, occurrence);
          const resolvedKey = occurrence === 1 ? nextKey : `${nextKey}__${occurrence - 1}`;

          if (occurrence > 1) {
            addSyntheticHit(hitCounts, WALKER_KEY_COLLISION_RULE_ID);
            anyRewritten = true;
          }
          if (keyNext.rewritten || next.rewritten) {
            anyRewritten = true;
          }
          rewrittenEntries.push({ key: resolvedKey, value: next.value });
        }
        if (!anyRewritten) return { value: input, rewritten: false };
        const proto = Object.getPrototypeOf(input);
        const out = Object.create(proto) as Record<string, unknown>;
        for (const entry of rewrittenEntries) {
          out[entry.key] = entry.value;
        }
        return { value: out as unknown, rewritten: true };
      }

      if (input && typeof input === "object") {
        // Deliberately skip opaque instances (Date/Map/URL/etc).
        return { value: input, rewritten: false };
      }

      return { value: input, rewritten: false };
    };

    const walked = walk(value, 0);
    const hits = [...hitCounts.entries()].map(([rule_id, count]) => ({ rule_id, count }));
    return { redacted: walked.value as T, hits, rewritten: walked.rewritten };
  }
}
