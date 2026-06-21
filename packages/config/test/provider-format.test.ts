import { describe, expect, it } from "bun:test";

import { CANONICAL_PROVIDER_VALUE_RE, isCanonicalProviderValue } from "../src/provider-format.js";

describe("isCanonicalProviderValue", () => {
  it("accepts every provider value currently in use", () => {
    // If any of these were non-canonical, routing-bias matching (strict ===)
    // would silently fail to resolve it. Pins the live provider vocabulary.
    for (const p of [
      "anthropic",
      "google",
      "groq",
      "local",
      "nvidia-nim",
      "openai",
      "opencode-go",
    ]) {
      expect(isCanonicalProviderValue(p)).toBe(true);
    }
  });

  it("rejects non-canonical forms that strict-=== matching would silently miss", () => {
    for (const bad of [
      "OpenAI", // uppercase
      "openai ", // trailing space
      " openai", // leading space
      "nvidia_nim", // underscore, not hyphen
      "Nvidia-Nim", // mixed case
      "open ai", // internal space
      "openai-", // trailing hyphen (empty segment)
      "-openai", // leading hyphen
      "openai--go", // empty segment
      "", // empty
    ]) {
      expect(isCanonicalProviderValue(bad)).toBe(false);
    }
  });

  it("is fully anchored — no partial matches", () => {
    expect(CANONICAL_PROVIDER_VALUE_RE.test("x openai y")).toBe(false);
  });
});
