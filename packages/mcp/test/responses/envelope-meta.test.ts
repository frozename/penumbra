import { describe, expect, it } from "bun:test";

import { isEnvelopeResult, makeEnvelopeResult } from "@src/responses/envelope.js";

const baseInput = { usedTokens: 1, limitTokens: 10, truncated: false };

describe("makeEnvelopeResult meta fields", () => {
  it("omits result_bytes when resultBytes is not provided", () => {
    const result = makeEnvelopeResult([], baseInput);
    expect("result_bytes" in result._meta).toBe(false);
  });

  it("keeps result_bytes: 0 instead of dropping it as falsy", () => {
    const result = makeEnvelopeResult([], { ...baseInput, resultBytes: 0 });
    expect(result._meta.result_bytes).toBe(0);
  });

  it("omits handle_id when handleId is not provided", () => {
    const result = makeEnvelopeResult([], baseInput);
    expect("handle_id" in result._meta).toBe(false);
  });

  it("passes handleId through to handle_id", () => {
    const result = makeEnvelopeResult([], { ...baseInput, handleId: "h-1" });
    expect(result._meta.handle_id).toBe("h-1");
  });

  it("never sets deprecated", () => {
    const result = makeEnvelopeResult([], baseInput);
    expect("deprecated" in result._meta).toBe(false);
  });

  it("passes truncated through to token_budget.truncated", () => {
    const result = makeEnvelopeResult([], { ...baseInput, truncated: true });
    expect(result._meta.token_budget?.truncated).toBe(true);
  });
});

describe("isEnvelopeResult", () => {
  it("rejects arrays even when flagged isEnvelope", () => {
    expect(isEnvelopeResult(Object.assign([], { isEnvelope: true }))).toBe(false);
  });

  it("requires the flag to be strictly true", () => {
    expect(isEnvelopeResult({ isEnvelope: "true" })).toBe(false);
    expect(isEnvelopeResult({ isEnvelope: 1 })).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isEnvelopeResult("x")).toBe(false);
    expect(isEnvelopeResult(undefined)).toBe(false);
  });

  it("accepts any object carrying only the structural flag", () => {
    expect(isEnvelopeResult({ isEnvelope: true })).toBe(true);
  });
});
