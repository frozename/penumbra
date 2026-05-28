export interface RedactionRule {
  keyPattern: RegExp;
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { keyPattern: /^(password|passwd|pwd)$/i },
  { keyPattern: /^(api[_-]?key|apikey)$/i },
  { keyPattern: /^(token|access[_-]?token|refresh[_-]?token)$/i },
  { keyPattern: /^(secret|client[_-]?secret)$/i },
  { keyPattern: /^authorization$/i },
];

export class RegexRedactor {
  constructor(private rules: RedactionRule[]) {}

  redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.rules.some((r) => r.keyPattern.test(k)) ? "[REDACTED]" : this.redact(v);
      }
      return out;
    }
    return value;
  }
}
