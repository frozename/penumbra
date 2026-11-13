import { expect, test } from "bun:test";

import { resolveLlmHttpOptions } from "@src/services/llm-http-options.js";

test("invalid generation budgets fail closed before inference", () => {
  for (const value of [0, -1, 0.5, Infinity, NaN, "512", 16_385]) {
    expect(() =>
      resolveLlmHttpOptions({ maxTokens: value }, { maxTokens: 512, timeoutMs: 30_000 }),
    ).toThrow("invalid generation maxTokens");
  }
  for (const value of [0, -1, "30000", 900_001]) {
    expect(() =>
      resolveLlmHttpOptions({ requestTimeoutMs: value }, { maxTokens: 512, timeoutMs: 30_000 }),
    ).toThrow("invalid generation requestTimeoutMs");
  }
  for (const requestExtras of [null, [], new Date(), "bad"]) {
    expect(() =>
      resolveLlmHttpOptions({ requestExtras }, { maxTokens: 512, timeoutMs: 30_000 }),
    ).toThrow("invalid generation requestExtras");
  }
});

test("configured deadlines cannot extend the caller deadline", () => {
  expect(
    resolveLlmHttpOptions({ requestTimeoutMs: 90_000 }, { maxTokens: 512, timeoutMs: 30_000 })
      .timeoutMs,
  ).toBe(30_000);
  expect(
    resolveLlmHttpOptions({ requestTimeoutMs: 5000 }, { maxTokens: 512, timeoutMs: 30_000 })
      .timeoutMs,
  ).toBe(5000);
});
