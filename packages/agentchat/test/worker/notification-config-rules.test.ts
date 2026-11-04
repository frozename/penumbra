import { describe, expect, it } from "bun:test";

import type { AgentChatConfig, NotificationConfig } from "@src/config/types.js";
import {
  DEFAULT_NOTIFICATION_EVENTS,
  loadNotificationConfig,
} from "@src/worker/notification-config.js";

function base(notifications?: NotificationConfig): AgentChatConfig {
  return {
    agents: [{ name: "codex", adapter: "codex-cli", options: {}, roles: [], auto_approve_to: [] }],
    default_roles: {},
    providers: [],
    notifications,
  };
}

describe("loadNotificationConfig rules", () => {
  it("prompt_policy in config beats the include-prompt env flag", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({ prompt_policy: "summary" }),
      env: { PENUMBRA_DISCORD_INCLUDE_PROMPT: "1" },
    });
    expect(cfg.promptPolicy).toBe("summary");
  });

  it("include-prompt env flag yields always", () => {
    const cfg = loadNotificationConfig({
      agentchat: base(),
      env: { PENUMBRA_DISCORD_INCLUDE_PROMPT: "1" },
    });
    expect(cfg.promptPolicy).toBe("always");
  });

  it("enabled:false disables even when a webhook resolves", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        enabled: false,
        channels: {
          discord: {
            kind: "discord_webhook",
            default_webhook_url_env: "PENUMBRA_DISCORD_WEBHOOK_URL",
          },
        },
      }),
      env: { PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/x" },
    });
    expect(cfg.enabled).toBe(false);
  });

  it("no webhook anywhere means disabled", () => {
    const cfg = loadNotificationConfig({
      agentchat: base(),
      env: {},
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.channels.discord?.defaultWebhookUrlEnv).toBe("PENUMBRA_DISCORD_WEBHOOK_URL");
    expect(cfg.channels.discord?.defaultWebhookUrl).toBeUndefined();
  });

  it("configured channels replace the implicit discord default", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        channels: {
          alerts: { kind: "discord_webhook", default_webhook_url_env: "ALERTS_URL" },
        },
      }),
      env: { PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/x" },
    });
    expect(cfg.channels.discord).toBeUndefined();
    expect(Object.keys(cfg.channels)).toEqual(["alerts"]);
    expect(cfg.enabled).toBe(false);
  });

  it("channel without default_webhook_url_env falls back to PENUMBRA_DISCORD_WEBHOOK_URL", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        channels: { ops: { kind: "discord_webhook" } },
      }),
      env: { PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/ops" },
    });
    expect(cfg.channels.ops?.defaultWebhookUrlEnv).toBe("PENUMBRA_DISCORD_WEBHOOK_URL");
    expect(cfg.channels.ops?.defaultWebhookUrl).toBe("https://discord.test/ops");
  });

  it("partial event overrides merge over the defaults", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({ events: { dispatch_start: true, merge_result: false } }),
      env: {},
    });
    expect(cfg.events).toEqual({
      ...DEFAULT_NOTIFICATION_EVENTS,
      dispatch_start: true,
      merge_result: false,
    });
  });

  it("no events block yields the default event map", () => {
    const cfg = loadNotificationConfig({
      agentchat: base(),
      env: {},
    });
    expect(cfg.events).toEqual(DEFAULT_NOTIFICATION_EVENTS);
    expect(cfg.events.dispatch_start).toBe(false);
    expect(cfg.events.claim_retry).toBe(false);
  });

  it("project route fields default when the route is empty", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({ routes: { projects: { p1: {} } } }),
      env: {},
    });
    expect(cfg.routes.projects.p1).toEqual({
      channel: "discord",
      webhookUrl: undefined,
      webhookUrlEnv: undefined,
      includePrompt: undefined,
      promptPolicy: undefined,
    });
  });

  it("project route fields pass through and resolve the webhook env", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        routes: {
          projects: {
            p2: {
              channel: "alerts",
              webhook_url_env: "P2_URL",
              include_prompt: true,
              prompt_policy: "summary",
            },
          },
        },
      }),
      env: { P2_URL: "https://discord.test/p2" },
    });
    expect(cfg.routes.projects.p2).toEqual({
      channel: "alerts",
      webhookUrl: "https://discord.test/p2",
      webhookUrlEnv: "P2_URL",
      includePrompt: true,
      promptPolicy: "summary",
    });
  });

  it("route webhook_url_env unset in env leaves webhookUrl undefined and keeps webhookUrlEnv", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        routes: { projects: { p3: { webhook_url_env: "P3_URL" } } },
      }),
      env: {},
    });
    expect(cfg.routes.projects.p3?.webhookUrl).toBeUndefined();
    expect(cfg.routes.projects.p3?.webhookUrlEnv).toBe("P3_URL");
  });

  it("agent identities map to camelCase fields", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        identities: {
          agents: {
            codex: {
              display_name: "Codex",
              avatar_url: "https://img.test/a.png",
              avatar_url_env: "AV",
            },
          },
        },
      }),
      env: {},
    });
    expect(cfg.identities.agents.codex).toEqual({
      displayName: "Codex",
      avatarUrl: "https://img.test/a.png",
      avatarUrlEnv: "AV",
    });
  });

  it("cost-quota summary defaults", () => {
    const cfg = loadNotificationConfig({
      agentchat: base(),
      env: {},
    });
    expect(cfg.summaries.costQuota).toEqual({
      enabled: true,
      interval: "daily",
      channel: "discord",
    });
  });

  it("cost-quota summary overrides pass through", () => {
    const cfg = loadNotificationConfig({
      agentchat: base({
        summaries: { cost_quota: { enabled: false, interval: "hourly", channel: "alerts" } },
      }),
      env: {},
    });
    expect(cfg.summaries.costQuota).toEqual({
      enabled: false,
      interval: "hourly",
      channel: "alerts",
    });
  });
});
