import { describe, expect, test } from "bun:test";

import {
  assertHandBilledSeatsWhitelisted,
  BilledHandSeatViolation,
  isBilledHandSeatViolation,
} from "../../src/files/billing-gate.js";

describe("assertHandBilledSeatsWhitelisted", () => {
  test("rejects a hand-authored pricing_mode:'api' seat whose api_provider is not whitelisted", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "openai-gpt52-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "openai",
        },
      ]);
    }).toThrow(/openai-gpt52-http/);
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "openai-gpt52-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "openai",
        },
      ]);
    }).toThrow(/BILLED_HAND_SEAT_WHITELIST/);
  });

  test("allows the whitelisted deepseek-v4-flash-http hand seat", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "deepseek-v4-flash-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "deepseek",
        },
      ]);
    }).not.toThrow();
  });

  test("exempts api_provider:'local' and pricing_mode:'subscription' seats", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "local-lfm2-planner-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "local",
        },
        {
          name: "codex-alibaba-acp",
          adapter: "stdio-acp",
          pricing_mode: "subscription",
          api_provider: "alibaba",
        },
      ]);
    }).not.toThrow();
  });

  test("skips generator-provenance seats (guarded at generation time)", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "openai-gpt52-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "openai",
          provenance: { source: "providers-sync" },
        },
      ]);
    }).not.toThrow();
  });

  test("rejects a hand billed openai-compat-http seat missing api_provider", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        { name: "mystery-http", adapter: "openai-compat-http", pricing_mode: "api" },
      ]);
    }).toThrow(/mystery-http/);
  });

  test("defaulted pricing_mode counts as billed", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        { name: "sneaky-http", adapter: "openai-compat-http", api_provider: "openai" },
      ]);
    }).toThrow(/sneaky-http/);
  });

  test("throws a typed violation for unwhitelisted billed hand seats", () => {
    expect(() => {
      assertHandBilledSeatsWhitelisted([
        {
          name: "openai-gpt52-http",
          adapter: "openai-compat-http",
          pricing_mode: "api",
          api_provider: "openai",
        },
      ]);
    }).toThrow(BilledHandSeatViolation);
    expect(
      isBilledHandSeatViolation(
        new BilledHandSeatViolation(
          "hand-authored per-token-billed seat(s) outside the whitelist: openai-gpt52-http (provider: openai)",
        ),
      ),
    ).toBe(true);
  });
});
