import { describe, expect, test } from "bun:test";

import {
  allocateBudget,
  availableBudget,
  type BudgetAllocation,
  type BudgetLimits,
  type CapsuleRefusal,
  CapsuleRefusalSchema,
  estimateTokens,
  fallbackTokenEstimate,
  type RefusalCode,
  TokenReportSchema,
  trimToTokenBudget,
  utf8ByteLength,
} from "@src/dispatch/capsule/index.js";

// With no counter, estimateTokens falls back to ceil(utf8_byte_length / 3),
// so an ASCII string of 3n bytes estimates to n tokens.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function expectRefusal(result: { ok: true } | CapsuleRefusal, code: RefusalCode): CapsuleRefusal {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a capsule refusal");
  }
  expect(result.code).toBe(code);
  expect(CapsuleRefusalSchema.safeParse(result).success).toBe(true);
  return result;
}

function allocationOf(result: BudgetAllocation | CapsuleRefusal): BudgetAllocation {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected a budget allocation");
  }
  return result;
}

describe("token estimation", () => {
  test("fallbackTokenEstimate is ceil(utf8 bytes / 3)", () => {
    expect(fallbackTokenEstimate("abcd")).toBe(2);
    expect(fallbackTokenEstimate("")).toBe(0);
    expect(fallbackTokenEstimate("abc")).toBe(1);
  });

  test("utf8ByteLength counts UTF-8 bytes", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("abc")).toBe(3);
  });

  test("estimateTokens uses the fallback estimator without a counter", () => {
    expect(estimateTokens("abcd")).toEqual({ tokens: 2, estimator: "fallback_estimate" });
  });

  test("estimateTokens uses an injected counter and reports tokenizer", () => {
    expect(estimateTokens("abcd", (t) => t.length * 10)).toEqual({
      tokens: 40,
      estimator: "tokenizer",
    });
  });

  test("estimateTokens survives a throwing counter", () => {
    const counter = (): number => {
      throw new Error("boom");
    };
    expect(() => estimateTokens("abcd", counter)).not.toThrow();
    expect(estimateTokens("abcd", counter)).toEqual({
      tokens: 2,
      estimator: "fallback_estimate",
    });
  });

  test.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    "estimateTokens rejects counter result %s",
    (bad) => {
      expect(estimateTokens("abcd", () => bad)).toEqual({
        tokens: 2,
        estimator: "fallback_estimate",
      });
    },
  );

  test("estimateTokens counts UTF-8 bytes for multibyte text", () => {
    expect(estimateTokens("漢".repeat(100))).toEqual({
      tokens: 100,
      estimator: "fallback_estimate",
    });
    expect(estimateTokens("😀".repeat(3))).toEqual({
      tokens: 4,
      estimator: "fallback_estimate",
    });
  });
});

describe("availableBudget", () => {
  test("subtracts reserves from the limit", () => {
    expect(availableBudget({ limit: 1000, reserve_response: 200, reserve_tool: 100 })).toEqual({
      ok: true,
      available: 700,
    });
    expect(availableBudget({ limit: 1000, reserve_response: 600, reserve_tool: 399 })).toEqual({
      ok: true,
      available: 1,
    });
  });

  const INVALID_BUDGETS: { label: string; limits: BudgetLimits }[] = [
    {
      label: "reserves consume the whole limit",
      limits: { limit: 1000, reserve_response: 600, reserve_tool: 400 },
    },
    { label: "zero limit", limits: { limit: 0, reserve_response: 0, reserve_tool: 0 } },
    { label: "negative limit", limits: { limit: -5, reserve_response: 0, reserve_tool: 0 } },
    { label: "NaN limit", limits: { limit: Number.NaN, reserve_response: 0, reserve_tool: 0 } },
    {
      label: "infinite limit",
      limits: { limit: Number.POSITIVE_INFINITY, reserve_response: 0, reserve_tool: 0 },
    },
    { label: "fractional limit", limits: { limit: 10.5, reserve_response: 0, reserve_tool: 0 } },
    {
      label: "negative reserve_response",
      limits: { limit: 1000, reserve_response: -1, reserve_tool: 0 },
    },
    {
      label: "negative reserve_tool",
      limits: { limit: 1000, reserve_response: 0, reserve_tool: -1 },
    },
    {
      label: "NaN reserve_response",
      limits: { limit: 1000, reserve_response: Number.NaN, reserve_tool: 0 },
    },
    {
      label: "NaN reserve_tool",
      limits: { limit: 1000, reserve_response: 0, reserve_tool: Number.NaN },
    },
    {
      label: "fractional reserve_response",
      limits: { limit: 1000, reserve_response: 0.5, reserve_tool: 0 },
    },
    {
      label: "reserves exceed the limit",
      limits: { limit: 100, reserve_response: 60, reserve_tool: 50 },
    },
    {
      label: "reserve_response alone exceeds the limit",
      limits: { limit: 100, reserve_response: 101, reserve_tool: 0 },
    },
    {
      label: "reserve_tool alone exceeds the limit",
      limits: { limit: 100, reserve_response: 0, reserve_tool: 101 },
    },
  ];

  test.each(INVALID_BUDGETS)("rejects $label", ({ limits }) => {
    expectRefusal(availableBudget(limits), "invalid_budget");
  });
});

describe("allocateBudget budget validation", () => {
  test("rejects an invalid limit", () => {
    expectRefusal(
      allocateBudget({
        limits: { limit: 0, reserve_response: 0, reserve_tool: 0 },
        items: [{ id: "e", text: "aaa", essential: true, priority: 0 }],
      }),
      "invalid_budget",
    );
  });

  test("admits essentials that exactly fill the available budget", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 10, reserve_response: 2, reserve_tool: 2 },
        items: [
          { id: "e1", text: "a".repeat(15), essential: true, priority: 0 },
          { id: "e2", text: "aaa", essential: true, priority: 0 },
        ],
      }),
    );
    expect(result.available).toBe(6);
    expect(result.used).toBe(6);
    expect(result.admitted).toEqual([
      { id: "e1", tokens: 5, essential: true },
      { id: "e2", tokens: 1, essential: true },
    ]);
    expect(result.dropped).toEqual([]);
  });

  test("essential overflow is a strict refusal with needed/available detail", () => {
    const result = allocateBudget({
      limits: { limit: 10, reserve_response: 2, reserve_tool: 2 },
      items: [
        { id: "e1", text: "a".repeat(15), essential: true, priority: 0 },
        { id: "e2", text: "aaa", essential: true, priority: 0 },
        { id: "e3", text: "a", essential: true, priority: 0 },
      ],
    });
    const refusal = expectRefusal(result, "essential_overflow");
    expect("admitted" in result).toBe(false);
    const detail = JSON.parse(refusal.detail) as { needed: number; available: number };
    expect(detail).toEqual({ needed: 7, available: 6 });
  });

  test("a later essential that does not fit still refuses the whole allocation", () => {
    const result = allocateBudget({
      limits: { limit: 10, reserve_response: 2, reserve_tool: 2 },
      items: [
        { id: "e1", text: "a".repeat(12), essential: true, priority: 0 },
        { id: "e2", text: "a".repeat(12), essential: true, priority: 0 },
      ],
    });
    const refusal = expectRefusal(result, "essential_overflow");
    const detail = JSON.parse(refusal.detail) as { needed: number; available: number };
    expect(detail).toEqual({ needed: 8, available: 6 });
  });

  test("an optional that exactly fills the remainder is admitted; one token over is dropped", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 10, reserve_response: 2, reserve_tool: 2 },
        items: [
          { id: "e1", text: "aaa", essential: true, priority: 0 },
          { id: "e2", text: "aaa", essential: true, priority: 0 },
          { id: "e3", text: "aaa", essential: true, priority: 0 },
          { id: "over", text: "a".repeat(12), essential: false, priority: 0 },
          { id: "fit", text: "a".repeat(9), essential: false, priority: 1 },
        ],
      }),
    );
    expect(result.used).toBe(6);
    expect(result.admitted).toEqual([
      { id: "e1", tokens: 1, essential: true },
      { id: "e2", tokens: 1, essential: true },
      { id: "e3", tokens: 1, essential: true },
      { id: "fit", tokens: 3, essential: false },
    ]);
    expect(result.dropped).toEqual([{ id: "over", tokens: 4, reason: "budget" }]);
  });
});

describe("allocateBudget optional admission", () => {
  test("orders optionals by priority then id code units regardless of input order", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 100, reserve_response: 0, reserve_tool: 0 },
        items: [
          { id: "aaa-low", text: "aaa", essential: false, priority: 2 },
          { id: "mmm-mid", text: "aaa", essential: false, priority: 1 },
          { id: "ZZZ-high", text: "aaa", essential: false, priority: 0 },
          { id: "Zed-tie", text: "aaa", essential: false, priority: 1 },
        ],
      }),
    );
    expect(result.admitted.map((item) => item.id)).toEqual([
      "ZZZ-high",
      "Zed-tie",
      "mmm-mid",
      "aaa-low",
    ]);
  });

  test("admits essentials first in input order, then optionals first-fit", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 100, reserve_response: 10, reserve_tool: 10 },
        items: [
          { id: "ess-b", text: "a".repeat(15), essential: true, priority: 99 },
          { id: "delta", text: "a".repeat(30), essential: false, priority: 2 },
          { id: "ess-a", text: "aaa", essential: true, priority: 0 },
          { id: "alpha", text: "a".repeat(9), essential: false, priority: 1 },
          { id: "big", text: "a".repeat(200), essential: false, priority: 0 },
          { id: "Zulu", text: "a".repeat(9), essential: false, priority: 1 },
          { id: "beta", text: "a".repeat(9), essential: false, priority: 3 },
          { id: "tiny", text: "aa", essential: false, priority: 4 },
        ],
      }),
    );
    expect(result.available).toBe(80);
    expect(result.used).toBe(80);
    expect(result.estimator).toBe("fallback_estimate");
    expect(result.admitted).toEqual([
      { id: "ess-b", tokens: 5, essential: true },
      { id: "ess-a", tokens: 1, essential: true },
      { id: "big", tokens: 67, essential: false },
      { id: "Zulu", tokens: 3, essential: false },
      { id: "alpha", tokens: 3, essential: false },
      { id: "tiny", tokens: 1, essential: false },
    ]);
    expect(result.dropped).toEqual([
      { id: "delta", tokens: 10, reason: "budget" },
      { id: "beta", tokens: 3, reason: "budget" },
    ]);
    expect(result.token_report).toEqual({
      estimator: "fallback_estimate",
      used: 80,
      limit: 100,
    });
    expect(TokenReportSchema.safeParse(result.token_report).success).toBe(true);
  });
});

describe("allocateBudget estimator", () => {
  test("a working counter marks the whole allocation tokenizer", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 100, reserve_response: 0, reserve_tool: 0 },
        counter: (t) => t.length,
        items: [
          { id: "e", text: "xy", essential: true, priority: 0 },
          { id: "o", text: "abcd", essential: false, priority: 0 },
        ],
      }),
    );
    expect(result.estimator).toBe("tokenizer");
    expect(result.admitted).toEqual([
      { id: "e", tokens: 2, essential: true },
      { id: "o", tokens: 4, essential: false },
    ]);
    expect(result.used).toBe(6);
    expect(result.token_report).toEqual({ estimator: "tokenizer", used: 6, limit: 100 });
  });

  test("no counter falls back to fallback_estimate with fallback tokens", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 100, reserve_response: 0, reserve_tool: 0 },
        items: [
          { id: "e", text: "xy", essential: true, priority: 0 },
          { id: "o", text: "abcd", essential: false, priority: 0 },
        ],
      }),
    );
    expect(result.estimator).toBe("fallback_estimate");
    expect(result.admitted).toEqual([
      { id: "e", tokens: 1, essential: true },
      { id: "o", tokens: 2, essential: false },
    ]);
    expect(result.used).toBe(3);
    expect(result.token_report.estimator).toBe("fallback_estimate");
  });

  test("a counter that throws for every item falls back entirely", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 100, reserve_response: 0, reserve_tool: 0 },
        counter: () => {
          throw new Error("boom");
        },
        items: [
          { id: "e", text: "xy", essential: true, priority: 0 },
          { id: "o", text: "abcd", essential: false, priority: 0 },
        ],
      }),
    );
    expect(result.estimator).toBe("fallback_estimate");
    expect(result.admitted).toEqual([
      { id: "e", tokens: 1, essential: true },
      { id: "o", tokens: 2, essential: false },
    ]);
    expect(result.used).toBe(3);
  });

  test("a counter that throws for one item marks the allocation fallback_estimate", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 1000, reserve_response: 0, reserve_tool: 0 },
        counter: (t) => {
          if (t.includes("secret")) {
            throw new Error("boom");
          }
          return t.length;
        },
        items: [
          { id: "e", text: "xy-secret", essential: true, priority: 0 },
          { id: "o", text: "abcd", essential: false, priority: 0 },
        ],
      }),
    );
    expect(result.estimator).toBe("fallback_estimate");
    expect(result.token_report.estimator).toBe("fallback_estimate");
  });

  test("an empty item list allocates with zero used", () => {
    const result = allocationOf(
      allocateBudget({
        limits: { limit: 50, reserve_response: 10, reserve_tool: 10 },
        items: [],
      }),
    );
    expect(result.available).toBe(30);
    expect(result.used).toBe(0);
    expect(result.admitted).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.token_report).toEqual({
      estimator: "fallback_estimate",
      used: 0,
      limit: 50,
    });
  });
});

describe("trimToTokenBudget", () => {
  test("keeps whole code points within maxTokens * 3 utf8 bytes", () => {
    const result = trimToTokenBudget("😀".repeat(10), 3);
    expect(result).toEqual({ text: "😀😀", truncated: true });
    expect(LONE_SURROGATE.test(result.text)).toBe(false);
  });

  test("returns the full text when it fits, including an exact fit", () => {
    expect(trimToTokenBudget("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(trimToTokenBudget("abc", 1)).toEqual({ text: "abc", truncated: false });
  });

  test("stops before a code point that would exceed the budget", () => {
    expect(trimToTokenBudget("a😀", 1)).toEqual({ text: "a", truncated: true });
    expect(LONE_SURROGATE.test("a")).toBe(false);
  });
});
