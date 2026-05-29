import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  withinBudget,
  truncateToTokens,
  DEFAULT_BUDGET,
} from "../../src/responses/budget.js";

describe("estimateTokens", () => {
  it("returns ceil(len/4)", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("withinBudget", () => {
  it("returns true when at or under limit", () => {
    expect(withinBudget("a".repeat(400), 100)).toBe(true);
  });
  it("returns false when over limit", () => {
    expect(withinBudget("a".repeat(4001), 1000)).toBe(false);
  });
});

describe("truncateToTokens", () => {
  it("returns unchanged text + truncated=false when within budget", () => {
    const r = truncateToTokens("hello world", 100);
    expect(r.text).toBe("hello world");
    expect(r.truncated).toBe(false);
  });
  it("truncates at charLimit and sets truncated=true", () => {
    const r = truncateToTokens("a".repeat(4000), 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(400);
  });
  it("does not slice through a surrogate pair (no lone trailing surrogate)", () => {
    // charLimit = 1 * 4 = 4. With one BMP char then astral emoji, the raw cut
    // at index 4 keeps "a", the first 😀, and a LONE high surrogate of the
    // second 😀. The boundary must back off to a whole codepoint instead.
    const r = truncateToTokens("a" + "😀".repeat(3), 1);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("a😀");
    expect(/[\uD800-\uDBFF]$/.test(r.text)).toBe(false);
  });
});

describe("DEFAULT_BUDGET", () => {
  it("is 8000", () => { expect(DEFAULT_BUDGET).toBe(8_000); });
});
