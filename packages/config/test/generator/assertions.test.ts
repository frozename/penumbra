import { describe, expect, test } from "bun:test";

import { GENERATOR_PROVENANCE_SOURCE } from "@src/files/billing-gate.js";
import {
  assertNoBilledGeneratedSeats,
  assertNoBilledHttpSeats,
} from "@src/generator/assertions.js";

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

    expect(() => {
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana"] });
    }).toThrow(/openai-gpt-http/);
    expect(() => {
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana"] });
    }).toThrow(/google-gemini-http/);
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

    expect(() => {
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] });
    }).not.toThrow();
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

    expect(() => {
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] });
    }).not.toThrow();
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

    expect(() => {
      assertNoBilledHttpSeats(agents, { allowedProviders: ["local", "sakana", "deepseek"] });
    }).toThrow(/generated-http-seat/);
  });
});

describe("assertNoBilledGeneratedSeats", () => {
  const generatorSource = GENERATOR_PROVENANCE_SOURCE;
  const opts = { allowedProviders: ["local", "sakana"], generatorSource };

  test("shares the canonical provenance source constant", () => {
    expect(GENERATOR_PROVENANCE_SOURCE).toBe("providers-sync");
  });

  test.each(["stdio-acp", "opencode-acp", "agy-cli", "cli"] as const)(
    "rejects a generator-owned %s seat with pricing_mode:'api' whose provider is outside the allowlist",
    (adapter) => {
      const agents = [
        {
          name: `${adapter}-generated-openai`,
          adapter,
          pricing_mode: "api" as const,
          api_provider: "openai",
          provenance: { source: generatorSource },
        },
      ];

      expect(() => {
        assertNoBilledGeneratedSeats(agents, opts);
      }).toThrow(new RegExp(`${adapter}-generated-openai`));
    },
  );

  test("rejects a generator-owned stdio-acp seat with omitted pricing_mode whose provider is outside the allowlist", () => {
    const agents = [
      {
        name: "stdio-acp-generated-openai-default-pricing",
        adapter: "stdio-acp",
        api_provider: "openai",
        provenance: { source: generatorSource },
      },
    ];

    expect(() => {
      assertNoBilledGeneratedSeats(agents, opts);
    }).toThrow(/stdio-acp-generated-openai-default-pricing/);
  });

  test("ignores a hand-authored generated-kind seat with pricing_mode:'api' whose provider is outside the allowlist", () => {
    const agents = [
      {
        name: "hand-authored-stdio",
        adapter: "stdio-acp",
        pricing_mode: "api" as const,
        api_provider: "openai",
      },
    ];

    expect(() => {
      assertNoBilledGeneratedSeats(agents, opts);
    }).not.toThrow();
  });

  test.each(["stdio-acp", "opencode-acp", "agy-cli", "cli"] as const)(
    "allows a generator-owned %s seat with pricing_mode:'subscription'",
    (adapter) => {
      const agents = [
        {
          name: `${adapter}-generated-subscription`,
          adapter,
          pricing_mode: "subscription" as const,
          subscription_provider: "openai",
          provenance: { source: generatorSource },
        },
      ];

      expect(() => {
        assertNoBilledGeneratedSeats(agents, opts);
      }).not.toThrow();
    },
  );
});
