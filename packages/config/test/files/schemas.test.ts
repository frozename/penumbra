import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import type { AgentChatConfig as LegacyAgentChatConfig } from "../../../agentchat/src/config/types.js";
import {
  AgentConfigSchema,
  AgentsConfigSchema,
  type AgentsConfig,
} from "../../src/files/agents.js";
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

  test("rejects unknown keys in nested config objects (strict)", () => {
    expect(() =>
      AgentConfigSchema.parse({
        name: "a",
        adapter: "stdio-acp",
        long_lived: true,
        long_lived_config: {
          standing_brief: "sb",
          bounds: { wall_clock_ms: 1, cost_cents: 0, max_sub_dispatches: 0 },
          typo_field: "x",
        },
      }),
    ).toThrow(/typo_field/);

    expect(() =>
      AgentConfigSchema.parse({
        name: "a",
        adapter: "stdio-acp",
        long_lived: true,
        long_lived_config: {
          standing_brief: "sb",
          bounds: {
            wall_clock_ms: 1,
            cost_cents: 0,
            max_sub_dispatches: 0,
            walll_clock_ms: 2,
          },
        },
      }),
    ).toThrow(/walll_clock_ms/);

    expect(() =>
      AgentConfigSchema.parse({
        name: "a",
        adapter: "stdio-acp",
        recall_context: { enabledd: true },
      }),
    ).toThrow(/enabledd/);

    expect(() =>
      AgentConfigSchema.parse({
        name: "a",
        adapter: "stdio-acp",
        rogue_top_level_field: 1,
      }),
    ).toThrow(/rogue_top_level_field/);

    expect(() =>
      AgentsConfigSchema.parse({
        agents: [{ name: "a", adapter: "stdio-acp" }],
        shell: { enabled: true, dangerous_commandz: [] },
      }),
    ).toThrow(/dangerous_commandz/);

    expect(() =>
      AgentsConfigSchema.parse({
        agents: [{ name: "a", adapter: "stdio-acp" }],
        thoughts: {
          enabled: true,
          analyze: { enabled: true, signals: { enabledd: true } },
        },
      }),
    ).toThrow(/enabledd/);
  });

  test("rejects duplicate agent names (would silently collapse in routing scorer)", () => {
    const result = AgentsConfigSchema.safeParse({
      agents: [
        { name: "dup-name", adapter: "stdio-acp" },
        { name: "other", adapter: "stdio-acp" },
        { name: "dup-name", adapter: "claude-cli" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const dupIssue = result.error.issues.find((i) => /duplicate agent name/.test(i.message));
      expect(dupIssue).toBeDefined();
      expect(dupIssue?.path).toEqual(["agents", 2, "name"]);
      expect(dupIssue?.message).toContain("'dup-name'");
    }
  });

  test("accepts agents with all-unique names (regression: refine should not false-positive)", () => {
    expect(() =>
      AgentsConfigSchema.parse({
        agents: [
          { name: "a", adapter: "stdio-acp" },
          { name: "b", adapter: "stdio-acp" },
          { name: "c", adapter: "stdio-acp" },
        ],
      }),
    ).not.toThrow();
  });

  test("thought analyzer agents accept scalar, array, and structured pools", () => {
    const parsed = AgentsConfigSchema.parse({
      agents: [{ name: "claude-acp-sonnet", adapter: "stdio-acp" }],
      thoughts: {
        enabled: true,
        analyze: {
          enabled: true,
          digest: {
            enabled: true,
            agent: {
              members: [
                { agent: "local-a", tier: "local" },
                { agent: "cloud-b", tier: "cloud" },
              ],
            },
          },
          signals: {
            enabled: true,
            agent: ["local-a", "cloud-b"],
            definitions: [{ name: "uncertainty", prompt: "list doubts" }],
          },
        },
      },
    });

    expect(parsed.thoughts?.analyze?.digest?.agent).toEqual({
      members: [
        { agent: "local-a", tier: "local" },
        { agent: "cloud-b", tier: "cloud" },
      ],
      select: "order",
      fallback_to_cloud: true,
    });
    expect(parsed.thoughts?.analyze?.signals?.agent).toEqual(["local-a", "cloud-b"]);
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
        vision_verify: {
          preferred_agent: "google-gemini-pro-acp",
          bias: "vision_verify",
          system_prompt:
            "You review UI-touching diffs for SILENT regressions text-focused reviewers miss. Compare removed (-) vs added (+) hunks for: dropped user-visible copy (labels, button text, tooltips, aria-labels, placeholders), removed interactive affordances (onClick/onChange handlers, buttons, links, inputs), and deleted style props or className entries. For each, state whether the removal is intentional (clearly replaced/moved nearby) or a likely silent drop from a refactor; flag silent drops as HIGH. Do not pixel-diff or comment on non-UI logic.",
          category_hints: ["ui", "frontend", "styles", "copy"],
          optional: true,
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

  test("role_routing accepts optional headroom_weighting", () => {
    const parsed = RoutingConfigSchema.parse({
      default_roles: {},
      role_routing: {
        exploration_policy: "unsampled-first",
        headroom_weighting: true,
      },
    });
    expect(parsed.role_routing?.headroom_weighting).toBe(true);
  });

  test("role_routing unknown keys throw", () => {
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        role_routing: {
          exploration_policy: "unsampled-first",
          typo_weighting: true,
        },
      }),
    ).toThrow(/typo_weighting/);
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

  test("personas accept preferred_agent pools without coercing strings", () => {
    const pooled = RoutingConfigSchema.parse({
      default_roles: {},
      personas: {
        architect: {
          preferred_agent: ["claude-acp-sonnet", "codex-acp-deep"],
          bias: "architect",
          system_prompt: "Focus on architecture.",
        },
      },
    });
    expect(pooled.personas?.architect?.preferred_agent).toEqual([
      "claude-acp-sonnet",
      "codex-acp-deep",
    ]);

    const single = RoutingConfigSchema.parse({
      default_roles: {},
      personas: {
        architect: {
          preferred_agent: "claude-acp-sonnet",
          bias: "architect",
          system_prompt: "Focus on architecture.",
        },
      },
    });
    expect(single.personas?.architect?.preferred_agent).toBe("claude-acp-sonnet");
  });

  test("personas accept optional marker and reject legacy blocking marker", () => {
    const optional = RoutingConfigSchema.parse({
      default_roles: {},
      personas: {
        ui_regression: {
          preferred_agent: "google-gemini-pro-acp",
          bias: "ui_regression",
          system_prompt: "Review UI regressions.",
          optional: true,
        },
      },
    });
    expect(optional.personas?.ui_regression?.optional).toBe(true);
    expect(() =>
      RoutingConfigSchema.parse({
        default_roles: {},
        personas: {
          ui_regression: {
            preferred_agent: "google-gemini-pro-acp",
            bias: "ui_regression",
            system_prompt: "Review UI regressions.",
            blocking: false,
          },
        },
      }),
    ).toThrow(/blocking/);
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

  test("accepts an opencode_console block under a provider", () => {
    const parsed = QuotasConfigSchema.parse(
      parseYaml(
        `providers:\n  - name: opencode-go\n    opencode_console:\n      workspace_id: "ws-abc"\n      base_url: "https://opencode.ai"\n      cookie_file: "~/.config/penumbra/secrets/opencode-go.cookie"\n`,
      ),
    );
    expect(parsed.providers[0]?.opencode_console?.workspace_id).toBe("ws-abc");
    expect(parsed.providers[0]?.opencode_console?.cookie_file).toContain("cookie");
  });

  test("rejects an inline cookie inside opencode_console", () => {
    expect(() =>
      QuotasConfigSchema.parse(
        parseYaml(
          `providers:\n  - name: opencode-go\n    opencode_console:\n      workspace_id: "ws"\n      cookie_file: "x"\n      cookie: "secret"\n`,
        ),
      ),
    ).toThrow();
  });

  test("live-shaped config with multiple canonical providers parses", () => {
    const live = {
      providers: [
        { name: "anthropic", model: "claude-sonnet-4-20250514", quota_usd_per_24h: 100 },
        { name: "openai", model: "gpt-4o", quota_usd_per_24h: 50 },
        {
          name: "google",
          model: "gemini-2.5-pro-preview-06-05",
          quota_usd_per_24h: 80,
          pressure_caps: { throttle_at: { warn: 70, refuse: 90 } },
        },
        {
          name: "opencode-go",
          opencode_console: {
            workspace_id: "ws-live",
            base_url: "https://opencode.ai",
            cookie_file: "~/.config/penumbra/secrets/opencode-go.cookie",
          },
        },
      ],
    };
    expect(() => QuotasConfigSchema.parse(live)).not.toThrow();
  });

  test("accepts synthetic_cap and cost_budget fields (legacy compat)", () => {
    const withLegacy = {
      providers: [
        {
          name: "anthropic",
          synthetic_cap: { max_dispatches: 10, window_seconds: 3600 },
          cost_budget_usd_per_5h: 5.0,
          cost_budget_usd_per_week: 50.0,
          cost_budget_usd_per_month: 150.0,
        },
      ],
    };
    const parsed = QuotasConfigSchema.parse(withLegacy);
    expect(parsed.providers[0]?.synthetic_cap?.max_dispatches).toBe(10);
    expect(parsed.providers[0]?.cost_budget_usd_per_5h).toBe(5.0);
    expect(parsed.providers[0]?.cost_budget_usd_per_week).toBe(50.0);
    expect(parsed.providers[0]?.cost_budget_usd_per_month).toBe(150.0);
  });

  test("rejects unknown/typo'd key on provider (strict)", () => {
    expect(() =>
      QuotasConfigSchema.parse({
        providers: [{ name: "anthropic", quota_usd_per_24h: 50, typo_field: 123 }],
      }),
    ).toThrow(/typo_field/);
  });

  test("rejects non-canonical name 'OpenAI' with name-path error", () => {
    const result = QuotasConfigSchema.safeParse({
      providers: [{ name: "OpenAI", quota_usd_per_24h: 50 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path[i.path.length - 1] === "name");
      expect(nameIssue).toBeDefined();
    }
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

describe("AgentConfigSchema — canonical provider values (daemon config-load boundary)", () => {
  const base = { name: "a", adapter: "stdio-acp" };

  test("accepts a canonical api_provider", () => {
    expect(AgentConfigSchema.parse({ ...base, api_provider: "nvidia-nim" }).api_provider).toBe(
      "nvidia-nim",
    );
  });

  test("rejects a non-canonical api_provider (the daemon scorer would silently never match it)", () => {
    expect(() => AgentConfigSchema.parse({ ...base, api_provider: "OpenAI" })).toThrow();
    expect(() => AgentConfigSchema.parse({ ...base, api_provider: "nvidia_nim" })).toThrow();
  });

  test("rejects a non-canonical subscription_provider", () => {
    expect(() =>
      AgentConfigSchema.parse({
        ...base,
        pricing_mode: "subscription",
        subscription_provider: "Anthropic",
      }),
    ).toThrow();
  });
});
