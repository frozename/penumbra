import { describe, expect, it } from "bun:test";

import { isEnvelopeResult, makeEnvelopeResult } from "../../src/responses/envelope.js";

describe("makeEnvelopeResult", () => {
  it("embeds content and token_budget in _meta", () => {
    const result = makeEnvelopeResult([{ type: "text", text: "hello" }], {
      usedTokens: 1,
      limitTokens: 1000,
      truncated: false,
      resultBytes: 5,
    });
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result._meta.token_budget?.used).toBe(1);
    expect(result._meta.token_budget?.limit).toBe(1000);
    expect(result._meta.token_budget?.truncated).toBe(false);
    expect(result._meta.result_bytes).toBe(5);
    expect(result.isEnvelope).toBe(true);
  });
});

describe("isEnvelopeResult", () => {
  it("returns true for an EnvelopeResult", () => {
    const r = makeEnvelopeResult([], {
      usedTokens: 0,
      limitTokens: 1000,
      truncated: false,
    });
    expect(isEnvelopeResult(r)).toBe(true);
  });
  it("returns false for a bare content array", () => {
    expect(isEnvelopeResult([{ type: "text", text: "x" }])).toBe(false);
  });
  it("returns false for null", () => {
    expect(isEnvelopeResult(null)).toBe(false);
  });
});
