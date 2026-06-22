import { describe, expect, it } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { TOOL_REGISTRY } from "../../src/tools/registry.js";
import {
  subscriptionPressureStatusHandler,
  SubscriptionPressureStatusInputSchema,
} from "../../src/tools/subscription-pressure-status.js";
import { fakeDaemon } from "../helpers.js";

type SubscriptionPressureStatusFn = DaemonClient["subscriptionPressureStatus"];
type SubscriptionPressureStatusReq = Parameters<SubscriptionPressureStatusFn>[0];

describe("subscription_pressure_status input schema", () => {
  it("accepts no arguments", () => {
    expect(SubscriptionPressureStatusInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects stale_after_seconds at zero", () => {
    expect(
      SubscriptionPressureStatusInputSchema.safeParse({ stale_after_seconds: 0 }).success,
    ).toBe(false);
  });
});

describe("subscription_pressure_status handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: SubscriptionPressureStatusReq[] = [];
    const subscriptionPressureStatus: SubscriptionPressureStatusFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        snapshots: [
          {
            provider: "openai",
            window_label: "24h",
            observed_at: "2026-05-07T00:00:00Z",
            state: "warning",
          },
        ],
        warnings: [],
      });
    };
    const handler = subscriptionPressureStatusHandler(fakeDaemon({ subscriptionPressureStatus }));

    const out = await handler({ provider: "openai", stale_after_seconds: 1800 });
    expect(calls).toEqual([{ provider: "openai", stale_after_seconds: 1800 }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual({
      snapshots: [
        {
          provider: "openai",
          window_label: "24h",
          observed_at: "2026-05-07T00:00:00Z",
          state: "warning",
        },
      ],
      warnings: [],
    });
  });
});

describe("tool registry entry", () => {
  it("registers subscription_pressure_status as read only", () => {
    const entry = TOOL_REGISTRY["subscription_pressure_status"];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(true);
  });
});
