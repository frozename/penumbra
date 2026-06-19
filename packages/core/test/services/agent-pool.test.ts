import { describe, expect, test } from "bun:test";
import { AgentPoolSchema } from "../../../config/src/files/agent-pool.js";
import { resolveAgentPool } from "../../src/services/agent-routing.js";

describe("resolveAgentPool", () => {
  test("returns an empty ordered list and drop reasons when every member is dropped", () => {
    const result = resolveAgentPool(["removed-seat"], {
      registry: new Set(["local-granite-3b-q8-http"]),
    });

    expect(result).toEqual({
      ordered: [],
      dropped: [{ agent: "removed-seat", reason: "not-in-registry" }],
    });
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

  test("orders surviving local members before cloud fallback members", () => {
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
      ordered: [
        { agent: "local-granite-3b-q8-http", tier: "local" },
        { agent: "gemini-acp-pro", tier: "cloud" },
      ],
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

    expect(result).toEqual({
      ordered: [],
      dropped: [{ agent: "local-granite-3b-q8-http", reason: "unhealthy" }],
    });
  });

  test("resolves scalar and array pools in declaration order by default", () => {
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
        { agent: "a", tier: "cloud" },
        { agent: "b", tier: "cloud" },
      ],
      dropped: [],
    });
  });

  test("honors fallback_to_cloud false when local members survive or do not survive", () => {
    const registry = ["local-a", "cloud-a"];

    expect(
      resolveAgentPool(
        {
          members: [
            { agent: "local-a", tier: "local" },
            { agent: "cloud-a", tier: "cloud" },
          ],
          fallback_to_cloud: false,
        },
        { registry },
      ),
    ).toEqual({
      ordered: [{ agent: "local-a", tier: "local" }],
      dropped: [],
    });

    expect(
      resolveAgentPool(
        {
          members: [
            { agent: "local-a", tier: "local" },
            { agent: "cloud-a", tier: "cloud" },
          ],
          fallback_to_cloud: false,
        },
        {
          registry,
          isHealthy: (agent) => agent !== "local-a",
        },
      ),
    ).toEqual({
      ordered: [],
      dropped: [{ agent: "local-a", reason: "unhealthy" }],
    });
  });

  test("uses cloud when no local member exists and fallback to cloud is enabled", () => {
    const result = resolveAgentPool(
      {
        members: [{ agent: "cloud-a", tier: "cloud" }],
        fallback_to_cloud: true,
      },
      {
        registry: ["cloud-a"],
      },
    );

    expect(result).toEqual({
      ordered: [{ agent: "cloud-a", tier: "cloud" }],
      dropped: [],
    });
  });

  test("rank selection reorders within local and cloud partitions", () => {
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
    expect(ranked.ordered).toEqual([
      { agent: "local-b", tier: "local" },
      { agent: "local-a", tier: "local" },
      { agent: "cloud-a", tier: "cloud" },
    ]);
  });

  test("prefers isLocal probe over tier labels and warns when they disagree", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const result = resolveAgentPool(
        {
          members: [{ agent: "local-a", tier: "cloud" }],
          fallback_to_cloud: false,
        },
        {
          registry: ["local-a"],
          isLocal: (agent) => agent === "local-a",
        },
      );

      expect(result.ordered).toEqual([{ agent: "local-a", tier: "local" }]);
      expect(warnings.length).toBe(1);
      expect(String(warnings[0]?.[0])).toContain("agent pool tier mismatch");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("does not call rank when rank selection has no ranker", () => {
    const result = resolveAgentPool(
      {
        members: [
          { agent: "local-a", tier: "local" },
          { agent: "local-b", tier: "local" },
        ],
        select: "rank",
        fallback_to_cloud: true,
      },
      {
        registry: ["local-a", "local-b"],
      },
    );
    expect(result.ordered).toEqual([
      { agent: "local-a", tier: "local" },
      { agent: "local-b", tier: "local" },
    ]);
  });
});
