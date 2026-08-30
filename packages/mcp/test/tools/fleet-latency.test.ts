import { describe, expect, it, mock } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { fleetLatencyHandler, FleetLatencyInputSchema } from "@src/tools/fleet-latency.js";

import { fakeDaemon } from "../helpers.js";

type FleetLatencyFn = DaemonClient["fleetLatency"];

describe("fleet_latency tool", () => {
  it("defaults to a 24 hour window", () => {
    expect(FleetLatencyInputSchema.parse({})).toEqual({ window_hours: 24 });
  });

  it("forwards window_hours and returns JSON text", async () => {
    const impl: FleetLatencyFn = (input) =>
      Promise.resolve({
        window: {
          from: "2026-06-02T12:00:00.000Z",
          to: "2026-06-03T12:00:00.000Z",
          hours: 24,
        },
        agents: [],
        input,
      });
    const fleetLatency = mock(impl);

    const result = await fleetLatencyHandler(fakeDaemon({ fleetLatency }))({ window_hours: 2 });

    expect(fleetLatency).toHaveBeenCalledWith({ window_hours: 2 });
    const block = result.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(JSON.parse(block.text)).toEqual({
      window: {
        from: "2026-06-02T12:00:00.000Z",
        to: "2026-06-03T12:00:00.000Z",
        hours: 24,
      },
      agents: [],
      input: { window_hours: 2 },
    });
  });
});
