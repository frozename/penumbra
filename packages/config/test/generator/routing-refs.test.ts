import { describe, expect, test } from "bun:test";

import type { AgentsConfig } from "../../src/files/agents.js";
import type { RoutingConfig } from "../../src/files/routing.js";

import { assertPruneSafe, collectMissingRoutingAgents } from "../../src/generator/routing-refs.js";

function agentsConfig(names: string[]): AgentsConfig {
  return {
    agents: names.map((name) => ({
      name,
      adapter: "openai-compat-http",
      options: {},
      roles: ["executor"],
      auto_approve_to: [],
      pricing_mode: "api",
    })),
  };
}

describe("collectMissingRoutingAgents", () => {
  test("flags routing references to agents absent from the agents config", () => {
    const agents = agentsConfig(["known-agent"]);
    const routing: RoutingConfig = {
      default_roles: { executor: "known-agent" },
      personas: {
        risk: {
          preferred_agent: "missing-reviewer",
          bias: "risk",
          system_prompt: "Check risk.",
        },
      },
      workloads: {
        review_adversarial: {
          eligible_roles: ["reviewer"],
          synthesizer: "known-agent",
        },
      },
    };

    expect(collectMissingRoutingAgents(agents, routing)).toEqual([
      { path: "personas.risk.preferred_agent", agent: "missing-reviewer" },
    ]);
  });

  test("returns no findings when every routing reference is a known agent", () => {
    const agents = agentsConfig(["known-agent"]);
    const routing: RoutingConfig = { default_roles: { executor: "known-agent" } };
    expect(collectMissingRoutingAgents(agents, routing)).toEqual([]);
  });

  test("flags a workload eligible_agents reference to an agent absent from the agents config", () => {
    const agents = agentsConfig(["known-agent"]);
    const routing: RoutingConfig = {
      default_roles: {},
      workloads: {
        review_adversarial: {
          eligible_roles: ["reviewer"],
          eligible_agents: ["missing-reviewer"],
        },
      },
    };

    expect(collectMissingRoutingAgents(agents, routing)).toEqual([
      { path: "workloads.review_adversarial.eligible_agents", agent: "missing-reviewer" },
    ]);
  });
});

describe("assertPruneSafe", () => {
  test("rejects pruning a generator-owned seat that a routing.yaml pool still references", () => {
    const routing: RoutingConfig = {
      default_roles: {},
      workloads: {
        review_adversarial: {
          eligible_roles: ["reviewer"],
          synthesizer: "local-granite-http",
        },
      },
    };

    expect(() => {
      assertPruneSafe(["local-granite-http"], routing);
    }).toThrow(/local-granite-http/);
  });

  test("allows pruning a seat that no routing.yaml pool references", () => {
    const routing: RoutingConfig = {
      default_roles: { executor: "kept-agent" },
    };
    expect(() => {
      assertPruneSafe(["vanished-agent"], routing);
    }).not.toThrow();
  });

  test("rejects pruning a generator-owned seat referenced only via workloads.<name>.eligible_agents", () => {
    const routing: RoutingConfig = {
      default_roles: {},
      workloads: {
        review_adversarial: {
          eligible_roles: ["reviewer"],
          eligible_agents: ["local-granite-http"],
        },
      },
    };

    expect(() => {
      assertPruneSafe(["local-granite-http"], routing);
    }).toThrow(/local-granite-http/);
  });
});
