import { expect, test } from "bun:test";

import { DEFAULT_REDACTION_RULES, RegexRedactor } from "@src/redaction/regex.js";

test("redacts default secret-like keys", () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const out = r.redact({ api_key: "sk-abc", password: "hunter2", ok: "fine" }) as Record<
    string,
    unknown
  >;
  expect(out.api_key).toBe("[REDACTED]");
  expect(out.password).toBe("[REDACTED]");
  expect(out.ok).toBe("fine");
});

test("redacts nested values", () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const out = r.redact({ a: { token: "xyz", b: 1 } }) as Record<string, unknown>;
  expect((out.a as Record<string, unknown>).token).toBe("[REDACTED]");
  expect((out.a as Record<string, unknown>).b).toBe(1);
});

test("never mutates the input", () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const input = { password: "p" };
  r.redact(input);
  expect(input.password).toBe("p");
});
