import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import type { AgentChatConfig as LegacyAgentChatConfig } from "../../../agentchat/src/config/types.js";
import { AgentsConfigSchema, type AgentsConfig } from "../../src/files/agents.js";
import { type AgentChatConfig } from "../../src/files/agentchat-types.js";
import { QuotasConfigSchema, type QuotasConfig } from "../../src/files/quotas.js";
import { RoutingConfigSchema, type RoutingConfig } from "../../src/files/routing.js";

function loadFixture(name: "agents" | "routing" | "quotas"): string {
  return readFileSync(join(import.meta.dir, "fixtures", `${name}.yaml`), "utf8");
}

describe("AgentsConfigSchema", () => {
  test("valid fixture parses", () => {
    const parsed = AgentsConfigSchema.parse(parseYaml(loadFixture("agents")));
    expect(parsed).toMatchObject({
      agents: [
        {
          name: "claude-acp-sonnet",
          adapter: "stdio-acp",
          options: { requestTimeoutMs: 60000 },
          roles: ["executor", "reviewer"],
          auto_approve_to: [],
          pricing_mode: "api",
        },
      ],
      thoughts: { enabled: true },
      shell: { enabled: true },
    } satisfies Partial<AgentsConfig>);
  });

  test("unknown top-level key throws", () => {
    expect(() =>
      AgentsConfigSchema.parse(parseYaml(`${loadFixture("agents")}\nfoo: bar\n`)),
    ).toThrow(/foo/);
  });

  test("missing required field throws", () => {
    const parsed = parseYaml(loadFixture("agents")) as { agents: Array<Record<string, unknown>> };
    delete parsed.agents[0]?.name;
    expect(() => AgentsConfigSchema.parse(parsed)).toThrow(/name/);
  });

  test("malformed type throws", () => {
    const parsed = parseYaml(loadFixture("agents")) as { agents: Array<Record<string, unknown>> };
    parsed.agents[0]!.options = { requestTimeoutMs: "60000" };
    expect(() => AgentsConfigSchema.parse(parsed)).toThrow(/requestTimeoutMs/);
  });
});

describe("RoutingConfigSchema", () => {
  test("valid fixture parses", () => {
    const parsed = RoutingConfigSchema.parse(parseYaml(loadFixture("routing")));
    const expected: RoutingConfig = {
      default_roles: {
        executor: "claude-acp-sonnet",
        reviewer: "codex-acp-deep",
        planner: "gemini-acp-pro",
      },
      role_routing: { exploration_policy: "unsampled-first" },
      personas: {
        architect: {
          preferred_agent: "claude-acp-sonnet",
          bias: "architect",
          system_prompt: "Focus on architecture boundaries and sequencing risk.",
        },
        simplifier: {
          preferred_agent: "codex-acp-deep",
          bias: "simplifier",
          system_prompt: "Prefer the smallest coherent implementation.",
        },
        "test-first": {
          preferred_agent: "codex-acp-deep",
          bias: "test-first",
          system_prompt: "Force explicit red-green-refactor progression.",
        },
        risk: {
          preferred_agent: "claude-acp-sonnet",
          bias: "risk",
          system_prompt: "Prioritize rollback and failure-mode controls.",
        },
        integration: {
          preferred_agent: "gemini-acp-pro",
          bias: "integration",
          system_prompt: "Validate integration boundaries and operational fit.",
        },
        security: {
          preferred_agent: "claude-acp-sonnet",
          bias: "security",
          system_prompt: "Prioritize exploitability and boundary correctness.",
          category_hints: ["security", "auth", "secrets"],
        },
        performance: {
          preferred_agent: "gemini-acp-pro",
          bias: "performance",
          system_prompt: "Focus on throughput and latency hazards.",
          category_hints: ["performance", "scaling"],
        },
        maintainability: {
          preferred_agent: "codex-acp-deep",
          bias: "maintainability",
          system_prompt: "Minimize long-term complexity and brittle coupling.",
        },
        devils_advocate: {
          preferred_agent: "gemini-acp-pro",
          bias: "devils_advocate",
          system_prompt: "Challenge assumptions and expose blind spots.",
        },
        simplicity: {
          preferred_agent: "codex-acp-deep",
          bias: "simplicity",
          system_prompt: "Reduce unnecessary moving parts.",
        },
        naming_clarity: {
          preferred_agent: "claude-acp-sonnet",
          bias: "naming_clarity",
          system_prompt: "Prioritize naming precision and semantic clarity.",
        },
        data_correctness: {
          preferred_agent: "gemini-acp-pro",
          bias: "data_correctness",
          system_prompt: "Validate invariants and data-shape correctness.",
        },
      },
      workloads: {
        review_adversarial: {
          eligible_roles: ["reviewer"],
          eligible_agents: ["architect", "security", "performance"],
          fan_out: 3,
          synthesizer: "claude-acp-sonnet",
        },
        plan_refine: {
          eligible_roles: ["planner"],
          eligible_agents: ["architect", "simplifier"],
          fan_out: 2,
          synthesizer: "claude-acp-sonnet",
        },
      },
    };
    expect(parsed).toEqual(expected);
  });

  test("unknown top-level key throws", () => {
    expect(() =>
      RoutingConfigSchema.parse(parseYaml(`${loadFixture("routing")}\nfoo: bar\n`)),
    ).toThrow(/foo/);
  });

  test("missing required field throws", () => {
    const parsed = parseYaml(loadFixture("routing")) as {
      workloads: { review_adversarial: Record<string, unknown> };
    };
    delete parsed.workloads.review_adversarial.eligible_roles;
    expect(() => RoutingConfigSchema.parse(parsed)).toThrow(/eligible_roles/);
  });

  test("malformed type throws", () => {
    const parsed = parseYaml(loadFixture("routing")) as { role_routing: Record<string, unknown> };
    parsed.role_routing.exploration_policy = 1;
    expect(() => RoutingConfigSchema.parse(parsed)).toThrow(/exploration_policy/);
  });

  test("workloads persona keys must exist in personas map", () => {
    const parsed = parseYaml(loadFixture("routing")) as {
      personas: Record<string, unknown>;
      workloads: { review_adversarial: { eligible_agents: string[] } };
    };
    delete parsed.personas.architect;
    expect(() => RoutingConfigSchema.parse(parsed)).toThrow(/unknown persona 'architect'/);
  });

  test("legacy top-level persona keys are rejected", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        review_personas: {},
      }),
    ).toThrow(/review_personas/);
  });
});

describe("QuotasConfigSchema", () => {
  test("valid fixture parses", () => {
    const parsed = QuotasConfigSchema.parse(parseYaml(loadFixture("quotas")));
    const expected: QuotasConfig = {
      providers: [
        {
          name: "anthropic",
          model: "claude-acp-sonnet",
          quota_usd_per_24h: 50,
          quota_tokens_per_24h: 5000000,
          quota_tokens_per_5h: 1000000,
          pressure_caps: {
            throttle_at: { warn: null, refuse: 80 },
          },
        },
      ],
    };
    expect(parsed).toEqual(expected);
  });

  test("unknown top-level key throws", () => {
    expect(() =>
      QuotasConfigSchema.parse(parseYaml(`${loadFixture("quotas")}\nfoo: bar\n`)),
    ).toThrow(/foo/);
  });

  test("missing required field throws", () => {
    const parsed = parseYaml(loadFixture("quotas")) as {
      providers: Array<Record<string, unknown>>;
    };
    delete parsed.providers[0]?.name;
    expect(() => QuotasConfigSchema.parse(parsed)).toThrow(/name/);
  });

  test("malformed type throws", () => {
    const parsed = parseYaml(loadFixture("quotas")) as {
      providers: Array<Record<string, unknown>>;
    };
    parsed.providers[0]!.quota_usd_per_24h = "50";
    expect(() => QuotasConfigSchema.parse(parsed)).toThrow(/quota_usd_per_24h/);
  });
});

describe("AgentChatConfig type compatibility", () => {
  test("composite type remains structurally compatible with legacy AgentChatConfig", () => {
    type LegacyComparable = Pick<
      LegacyAgentChatConfig,
      "agents" | "default_roles" | "role_routing" | "providers" | "thoughts" | "shell"
    >;

    expectTypeOf<AgentChatConfig>().toMatchObjectType<LegacyComparable>();
  });
});
