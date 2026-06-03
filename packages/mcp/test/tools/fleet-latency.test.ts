import { describe, expect, it, mock } from "bun:test";
import { FleetLatencyInputSchema, fleetLatencyHandler } from "../../src/tools/fleet-latency.js";

describe("fleet_latency tool", () => {
  it("defaults to a 24 hour window", () => {
    expect(FleetLatencyInputSchema.parse({})).toEqual({ window_hours: 24 });
  });

  it("forwards window_hours and returns JSON text", async () => {
    const daemon = {
      fleetLatency: mock(async (input: unknown) => ({
        window: {
          from: "2026-06-02T12:00:00.000Z",
          to: "2026-06-03T12:00:00.000Z",
          hours: 24,
        },
        agents: [],
        input,
      })),
    };

    const result = await fleetLatencyHandler(daemon as any)({ window_hours: 2 });

    expect(daemon.fleetLatency).toHaveBeenCalledWith({ window_hours: 2 });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
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
