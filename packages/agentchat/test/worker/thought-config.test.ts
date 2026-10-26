import { AgentsConfigSchema } from "@penumbra/config";
import { describe, expect, it } from "bun:test";

import { AgentChatConfigSchema } from "@src/config/types.js";
import { loadThoughtsConfig } from "@src/worker/thought-config.js";

describe("thoughts config schema", () => {
  it("accepts a minimal thoughts block", () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: "codex", adapter: "codex-cli" }],
      thoughts: {
        enabled: true,
        capture: {
          adapters: { "stdio-acp": true },
        },
        analyze: {
          enabled: true,
          only_when: ["pr_opened"],
          digest: {
            enabled: true,
            agent: {
              members: [
                { agent: "local-gemma26", tier: "local" },
                { agent: "codex-acp-fast", tier: "cloud" },
              ],
            },
          },
          signals: {
            enabled: true,
            agent: ["local-gemma26", "codex-acp-fast"],
            definitions: [{ name: "uncertainty", prompt: "list doubts" }],
          },
        },
      },
    });
    expect(parsed.thoughts?.enabled).toBe(true);
    expect(parsed.thoughts?.analyze?.digest?.agent).toEqual({
      members: [
        { agent: "local-gemma26", tier: "local" },
        { agent: "codex-acp-fast", tier: "cloud" },
      ],
      select: "order",
      fallback_to_cloud: true,
    });
    expect(parsed.thoughts?.analyze?.signals?.agent).toEqual(["local-gemma26", "codex-acp-fast"]);
    expect(parsed.thoughts?.analyze?.signals?.definitions[0]?.name).toBe("uncertainty");
  });
});

describe("loadThoughtsConfig", () => {
  it("returns a disabled config when no thoughts block is present", () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [
          { name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] },
        ],
        default_roles: {},
        providers: [],
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.capture.maxTextBytes).toBe(16384);
    expect(cfg.capture.maxStreamBytes).toBe(1048576);
    expect(cfg.analyze.enabled).toBe(false);
  });

  it("preserves capture caps and analyze gating from the config", () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [
          { name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] },
        ],
        default_roles: {},
        providers: [],
        thoughts: {
          enabled: true,
          capture: {
            max_text_bytes: 8000,
            max_stream_bytes: 200000,
            adapters: { "stdio-acp": true, "cli-spawn": false },
            per_agent_overrides: { "gemini-acp-pro": false },
          },
          analyze: {
            enabled: true,
            only_when: ["pr_opened", "test_failed"],
            digest: {
              enabled: true,
              agent: "local-gemma26",
              max_input_chars: 4000,
              timeout_ms: 30000,
            },
            signals: {
              enabled: true,
              agent: "local-gemma31",
              timeout_ms: 30000,
              definitions: [
                { name: "uncertainty", prompt: "list doubts" },
                { name: "security", prompt: "list security risks" },
              ],
            },
          },
        },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.capture.maxTextBytes).toBe(8000);
    expect(cfg.capture.adapters["stdio-acp"]).toBe(true);
    expect(cfg.capture.adapters["cli-spawn"]).toBe(false);
    expect(cfg.capture.perAgentOverrides["gemini-acp-pro"]).toBe(false);
    expect(cfg.analyze.onlyWhen).toEqual(["pr_opened", "test_failed"]);
    expect(cfg.analyze.digest.pool).toBe("local-gemma26");
    expect(cfg.analyze.digest.maxInputChars).toBe(4000);
    expect(cfg.analyze.signals.pool).toBe("local-gemma31");
    expect(cfg.analyze.signals.definitions).toHaveLength(2);
    expect(cfg.analyze.signals.definitions[1]?.name).toBe("security");
  });

  it("preserves object pools and does not default missing analyzer agents", () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [
          { name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] },
        ],
        default_roles: {},
        providers: [],
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
              definitions: [{ name: "uncertainty", prompt: "list doubts" }],
            },
          },
        },
      },
    });

    expect(cfg.analyze.digest.pool).toEqual({
      members: [
        { agent: "local-a", tier: "local" },
        { agent: "cloud-b", tier: "cloud" },
      ],
    });
    expect(cfg.analyze.signals.pool).toBeNull();
  });

  it("disables analyze when capture is disabled", () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [
          { name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] },
        ],
        default_roles: {},
        providers: [],
        thoughts: {
          enabled: false,
          analyze: { enabled: true, digest: { enabled: true, agent: "local-gemma26" } },
        },
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.analyze.enabled).toBe(false);
  });
});

describe("thought analyzer input budget default (#295)", () => {
  const baseAgentchat = {
    agents: [{ name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] }],
    default_roles: {},
    providers: [],
  };

  it("loadThoughtsConfig defaults the digest budget to 20000 and leaves signals to inherit it", () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        ...baseAgentchat,
        thoughts: {
          enabled: true,
          analyze: {
            enabled: true,
            digest: { enabled: true, agent: "local-a" },
            signals: {
              enabled: true,
              agent: "local-a",
              definitions: [{ name: "uncertainty", prompt: "list doubts" }],
            },
          },
        },
      },
    });
    expect(cfg.analyze.digest.maxInputChars).toBe(20000);
    expect(cfg.analyze.signals.maxInputChars).toBeNull();
  });

  it("agentchat schema defaults digest max_input_chars to 20000", () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: "codex", adapter: "codex-cli" }],
      thoughts: { enabled: true, analyze: { enabled: true, digest: { enabled: true } } },
    });
    expect(parsed.thoughts?.analyze?.digest?.max_input_chars).toBe(20000);
  });

  it("@penumbra/config schema defaults digest max_input_chars to 20000", () => {
    const parsed = AgentsConfigSchema.parse({
      agents: [{ name: "claude-acp-sonnet", adapter: "stdio-acp" }],
      thoughts: { enabled: true, analyze: { enabled: true, digest: { enabled: true } } },
    });
    expect(parsed.thoughts?.analyze?.digest?.max_input_chars).toBe(20000);
  });

  it("an explicit max_input_chars still overrides the default", () => {
    const thoughts = {
      enabled: true,
      analyze: { enabled: true, digest: { enabled: true, max_input_chars: 50000 } },
    };
    const cfg = loadThoughtsConfig({ agentchat: { ...baseAgentchat, thoughts } });
    expect(cfg.analyze.digest.maxInputChars).toBe(50000);
    const agentchatParsed = AgentChatConfigSchema.parse({
      agents: [{ name: "codex", adapter: "codex-cli" }],
      thoughts,
    });
    expect(agentchatParsed.thoughts?.analyze?.digest?.max_input_chars).toBe(50000);
    const configParsed = AgentsConfigSchema.parse({
      agents: [{ name: "claude-acp-sonnet", adapter: "stdio-acp" }],
      thoughts,
    });
    expect(configParsed.thoughts?.analyze?.digest?.max_input_chars).toBe(50000);
  });
});
