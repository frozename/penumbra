import { describe, expect, it } from "bun:test";

import { createDiscordRateLimiter } from "@src/worker/discord-rate-limit.js";

describe("createDiscordRateLimiter", () => {
  it("suppresses repeated noisy events for the same webhook and coalesce key within the window", () => {
    let now = 1_000;
    const limiter = createDiscordRateLimiter({
      now: () => now,
      windowMs: 5_000,
    });

    expect(limiter.shouldSend({ webhookKey: "route-a", coalesceKey: "claim_retry" })).toBe(true);
    expect(limiter.shouldSend({ webhookKey: "route-a", coalesceKey: "claim_retry" })).toBe(false);

    now += 5_000;

    expect(limiter.shouldSend({ webhookKey: "route-a", coalesceKey: "claim_retry" })).toBe(true);
  });

  it("keys suppression by webhook route as well as coalesce key", () => {
    const now = 2_000;
    const limiter = createDiscordRateLimiter({
      now: () => now,
      windowMs: 10_000,
    });

    expect(limiter.shouldSend({ webhookKey: "route-a", coalesceKey: "permission_decided" })).toBe(
      true,
    );
    expect(limiter.shouldSend({ webhookKey: "route-b", coalesceKey: "permission_decided" })).toBe(
      true,
    );
    expect(limiter.shouldSend({ webhookKey: "route-a", coalesceKey: "permission_decided" })).toBe(
      false,
    );
  });

  it("allows high-signal events when no coalesce key is provided", () => {
    const limiter = createDiscordRateLimiter({
      now: () => 3_000,
      windowMs: 60_000,
    });

    expect(limiter.shouldSend({ webhookKey: "route-a" })).toBe(true);
    expect(limiter.shouldSend({ webhookKey: "route-a" })).toBe(true);
  });
});
