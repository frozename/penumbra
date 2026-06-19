import { describe, expect, test } from "bun:test";
import { AgentPoolSchema } from "../../../config/src/files/agent-pool.js";
import { resolveAgentPool } from "../../src/services/agent-routing.js";

describe("resolveAgentPool", () => {
  test("returns null when every member is dropped", () => {
    const result = resolveAgentPool(["removed-seat"], {
      registry: new Set(["local-granite-3b-q8-http"]),
    });

    expect(result).toBeNull();
  });

  test("drops unregistered members and preserves surviving local member", () => {
    const result = resolveAgentPool(["removed-seat", "local-granite-3b-q8-http"], {
      registry: new Set(["local-granite-3b-q8-http"]),
      isLocal: (agent) => agent.startsWith("local-"),
    });

    expect(result).toEqual({
      ordered: [{ agent: "local-granite-3b-q8-http", tier: "local" }],
      dropped: [{ agent: "removed-seat", reason: "not-in-registry" }],
    });
  });

  test("withholds cloud while a local member survives, then falls back to cloud", () => {
    const pool = AgentPoolSchema.parse({
      members: [{ agent: "local-granite-3b-q8-http" }, { agent: "gemini-acp-pro", tier: "cloud" }],
      fallback_to_cloud: true,
    });
    const registry = ["local-granite-3b-q8-http", "gemini-acp-pro"];

    const localHealthy = resolveAgentPool(pool, {
      registry,
      isLocal: (agent) => agent.startsWith("local-"),
    });
    expect(localHealthy).toEqual({
      ordered: [{ agent: "local-granite-3b-q8-http", tier: "local" }],
      dropped: [],
    });

    const localUnhealthy = resolveAgentPool(pool, {
      registry,
      isLocal: (agent) => agent.startsWith("local-"),
      isHealthy: (agent) => agent !== "local-granite-3b-q8-http",
    });
    expect(localUnhealthy).toEqual({
      ordered: [{ agent: "gemini-acp-pro", tier: "cloud" }],
      dropped: [{ agent: "local-granite-3b-q8-http", reason: "unhealthy" }],
    });
  });

  test("fails closed when fallback to cloud is disabled and no local member survives", () => {
    const result = resolveAgentPool(
      {
        members: [
          { agent: "local-granite-3b-q8-http" },
          { agent: "gemini-acp-pro", tier: "cloud" },
        ],
        select: "rank",
        fallback_to_cloud: false,
      },
      {
        registry: ["local-granite-3b-q8-http", "gemini-acp-pro"],
        isLocal: (agent) => agent.startsWith("local-"),
        isHealthy: (agent) => agent !== "local-granite-3b-q8-http",
      },
    );

    expect(result).toBeNull();
  });

  test("resolves scalar and array pools as one-member and two-member pools", () => {
    expect(
      resolveAgentPool("x", {
        registry: ["x"],
      }),
    ).toEqual({
      ordered: [{ agent: "x", tier: "cloud" }],
      dropped: [],
    });

    expect(
      resolveAgentPool(["a", "b"], {
        registry: ["a", "b"],
        rank: (agents) => [...agents].reverse(),
      }),
    ).toEqual({
      ordered: [
        { agent: "b", tier: "cloud" },
        { agent: "a", tier: "cloud" },
      ],
      dropped: [],
    });
  });

  test("supports round-robin and rank selection within local and cloud partitions", () => {
    const roundRobin = resolveAgentPool(
      {
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "local-b", tier: "local" },
          { agent: "cloud-a", tier: "cloud" },
        ],
        select: "round_robin",
        fallback_to_cloud: true,
      },
      {
        registry: ["local-a", "local-b", "cloud-a"],
      },
    );
    expect(roundRobin?.ordered).toEqual([
      { agent: "local-b", tier: "local" },
      { agent: "local-a", tier: "local" },
    ]);

    const ranked = resolveAgentPool(
      {
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "local-b", tier: "local" },
          { agent: "cloud-a", tier: "cloud" },
        ],
        select: "rank",
        fallback_to_cloud: true,
      },
      {
        registry: ["local-a", "local-b", "cloud-a"],
        rank: (agents) => [...agents].reverse(),
      },
    );
    expect(ranked?.ordered).toEqual([
      { agent: "local-b", tier: "local" },
      { agent: "local-a", tier: "local" },
    ]);
  });
});
