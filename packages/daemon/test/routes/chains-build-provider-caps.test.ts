import type { ProviderQuota } from "@penumbra/core";

import { describe, expect, it } from "bun:test";

import { buildProviderCaps } from "@src/maestro/build-provider-caps.js";

describe("buildProviderCaps", () => {
  it("merges default + per-model rows for the same provider", () => {
    const providerQuotas: ProviderQuota[] = [
      {
        provider: "google",
        pressure_caps: { daily: { warn: null, refuse: 90 } },
      },
      {
        provider: "google",
        model: "gemini-3.1-pro-preview",
        pressure_caps: { daily: { warn: null, refuse: 50 } },
      },
    ];

    const result = buildProviderCaps(providerQuotas);

    expect(result).toEqual({
      google: {
        default: { daily: { warn: null, refuse: 90 } },
        perModel: { "gemini-3.1-pro-preview": { daily: { warn: null, refuse: 50 } } },
      },
    });
  });

  it("produces only default for a single no-model row", () => {
    const providerQuotas: ProviderQuota[] = [
      {
        provider: "anthropic",
        pressure_caps: { five_hour: { warn: null, refuse: 90 } },
      },
    ];

    const result = buildProviderCaps(providerQuotas);

    expect(result).toEqual({
      anthropic: {
        default: { five_hour: { warn: null, refuse: 90 } },
        perModel: undefined,
      },
    });
  });

  it("skips provider rows without pressure_caps entirely", () => {
    const providerQuotas: ProviderQuota[] = [
      {
        provider: "openai",
        quota_usd_per_24h: 100,
      },
    ];

    const result = buildProviderCaps(providerQuotas);

    expect(result).toEqual({});
  });
});
