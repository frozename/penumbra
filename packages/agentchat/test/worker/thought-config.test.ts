import { describe, expect, it } from "bun:test";
import { AgentChatConfigSchema } from "../../src/config/types.js";
import { loadThoughtsConfig } from "../../src/worker/thought-config.js";

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
          digest: { enabled: true, agent: "local-gemma26" },
          signals: {
            enabled: true,
            agent: "local-gemma26",
            definitions: [{ name: "uncertainty", prompt: "list doubts" }],
          },
        },
      },
    });
    expect(parsed.thoughts?.enabled).toBe(true);
    expect(parsed.thoughts?.analyze?.signals?.definitions?.[0]?.name).toBe("uncertainty");
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
    expect(cfg.analyze.digest.agent).toBe("local-gemma26");
    expect(cfg.analyze.digest.maxInputChars).toBe(4000);
    expect(cfg.analyze.signals.definitions).toHaveLength(2);
    expect(cfg.analyze.signals.definitions[1]?.name).toBe("security");
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
