import { describe, expect, test } from "bun:test";

import { assertNoBilledHttpSeats } from "../../src/generator/assertions.js";

describe("assertNoBilledHttpSeats", () => {
  test("rejects a generated openai-compat-http seat with pricing_mode:'api' whose provider is outside the allowlist", () => {
    const agents = [
      {
        name: "openai-gpt-http",
        adapter: "openai-compat-http",
        pricing_mode: "api" as const,
        api_provider: "openai",
      },
      {
        name: "google-gemini-http",
        adapter: "openai-compat-http",
        pricing_mode: "api" as const,
        api_provider: "google",
      },
    ];

    expect(() =>
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana"] }),
    ).toThrow(/openai-gpt-http/);
    expect(() =>
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana"] }),
    ).toThrow(/google-gemini-http/);
  });

  test("allows an explicitly whitelisted deepseek-v4-flash-http seat", () => {
    const agents = [
      {
        name: "deepseek-v4-flash-http",
        adapter: "openai-compat-http",
        pricing_mode: "api" as const,
        api_provider: "deepseek",
      },
    ];

    expect(() =>
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] }),
    ).not.toThrow();
  });

  test("allows a local http seat that carries api_provider:'local' when 'local' is allowed", () => {
    const agents = [
      {
        name: "local-llama-http",
        adapter: "openai-compat-http",
        pricing_mode: "api" as const,
        api_provider: "local",
      },
      {
        name: "sakana-fugu-http",
        adapter: "openai-compat-http",
        pricing_mode: "subscription" as const,
        subscription_provider: "sakana",
      },
    ];

    expect(() =>
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] }),
    ).not.toThrow();
  });

  test("rejects a billed openai-compat-http seat with no api_provider", () => {
    const agents = [
      {
        name: "generated-http-seat",
        adapter: "openai-compat-http",
        pricing_mode: "api" as const,
        // missing api_provider on a generated billed seat is a generator bug.
      },
    ];

    expect(() =>
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] }),
    ).toThrow(/generated-http-seat/);
  });
});
