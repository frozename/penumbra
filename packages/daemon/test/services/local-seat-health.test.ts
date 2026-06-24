import { describe, expect, test } from "bun:test";

import { createLocalSeatHealthService } from "../../src/services/local-seat-health.js";

const localSeat = {
  name: "local-bge",
  roles: ["reviewer"],
  adapter: "openai-compat-http",
  options: { baseUrl: "http://127.0.0.1:7944", model: "bge-m3" },
};

describe("local seat health service", () => {
  test("admits a healthy local openai-compatible seat when its model is served", async () => {
    const service = createLocalSeatHealthService({
      agents: () => [localSeat],
      ttlMs: 20_000,
      fetch: async () =>
        new Response(
          JSON.stringify({ data: [{ id: "bge-m3-GGUF/bge-m3-FP16.gguf" }, { id: "bge-m3" }] }),
        ),
    });

    await service.refresh();

    expect(service.getUnhealthyAgents()).toEqual(new Set());
  });

  test("fails closed for down or unknown local seats but never excludes non-local seats", async () => {
    const cloudSeat = {
      name: "cloud-http",
      roles: ["reviewer"],
      adapter: "openai-compat-http",
      options: { baseUrl: "https://api.example.invalid", model: "missing" },
    };
    let calls = 0;
    const service = createLocalSeatHealthService({
      agents: () => [localSeat, cloudSeat],
      ttlMs: 20_000,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ id: "different-model" }] }));
      },
    });

    await service.refresh();

    expect(calls).toBe(1);
    expect(service.getUnhealthyAgents()).toEqual(new Set(["local-bge"]));
  });

  test("does not re-probe a local seat inside the TTL window", async () => {
    let now = 1_000;
    let calls = 0;
    const service = createLocalSeatHealthService({
      agents: () => [localSeat],
      ttlMs: 20_000,
      now: () => now,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ id: "bge-m3" }] }));
      },
    });

    await service.refresh();
    await service.refresh();
    now += 20_001;
    await service.refresh();

    expect(calls).toBe(2);
  });
});
