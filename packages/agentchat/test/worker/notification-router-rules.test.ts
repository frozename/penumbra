import { describe, expect, it } from "bun:test";

import { DEFAULT_NOTIFICATION_EVENTS } from "@src/worker/notification-config.js";
import type { RuntimeNotificationConfig } from "@src/worker/notification-config.js";
import { resolveNotificationRoute } from "@src/worker/notification-router.js";

function baseConfig(overrides?: {
  enabled?: boolean;
  promptPolicy?: RuntimeNotificationConfig["promptPolicy"];
  channels?: RuntimeNotificationConfig["channels"];
  routes?: RuntimeNotificationConfig["routes"];
  identities?: RuntimeNotificationConfig["identities"];
}): RuntimeNotificationConfig {
  return {
    enabled: overrides?.enabled ?? true,
    promptPolicy: overrides?.promptPolicy ?? "never",
    channels: overrides?.channels ?? {
      discord: {
        kind: "discord_webhook",
        defaultWebhookUrl: "https://discord.test/api/webhooks/default/token",
        defaultWebhookUrlEnv: "PENUMBRA_DISCORD_WEBHOOK_URL",
      },
    },
    routes: overrides?.routes ?? { projects: {} },
    identities: overrides?.identities ?? { agents: {} },
    events: { ...DEFAULT_NOTIFICATION_EVENTS },
    summaries: {
      costQuota: {
        enabled: true,
        interval: "daily",
        channel: "discord",
      },
    },
  };
}

describe("resolveNotificationRoute webhook precedence", () => {
  it("prefers the route inline webhookUrl over the env-resolved webhookUrlEnv", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        routes: {
          projects: {
            penumbra: {
              channel: "discord",
              webhookUrl: "https://discord.test/api/webhooks/inline/token",
              webhookUrlEnv: "PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL",
            },
          },
        },
      }),
      env: {
        PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL:
          "https://discord.test/api/webhooks/env/token",
      },
      projectId: "penumbra",
    });

    expect(resolved?.webhookUrl).toBe("https://discord.test/api/webhooks/inline/token");
    expect(resolved?.routeKey).toBe("project:penumbra");
  });

  it("returns null when the route inline webhookUrl is empty instead of falling back", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        routes: {
          projects: {
            penumbra: {
              channel: "discord",
              webhookUrl: "",
            },
          },
        },
      }),
      env: {},
      projectId: "penumbra",
    });

    expect(resolved).toBeNull();
  });

  it("ignores the channel defaultWebhookUrlEnv — only the inline defaultWebhookUrl is used", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        channels: {
          discord: {
            kind: "discord_webhook",
            defaultWebhookUrlEnv: "PENUMBRA_DISCORD_WEBHOOK_URL",
          },
        },
      }),
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
      },
    });

    expect(resolved).toBeNull();
  });
});

describe("resolveNotificationRoute channel guards", () => {
  it("returns null when the project route names a channel that does not exist", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        routes: {
          projects: {
            penumbra: { channel: "missing-channel" },
          },
        },
      }),
      env: {},
      projectId: "penumbra",
    });

    expect(resolved).toBeNull();
  });

  it("returns null when the resolved channel entry is explicitly undefined", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        channels: { discord: undefined },
        routes: {
          projects: {
            penumbra: { channel: "discord" },
          },
        },
      }),
      env: {},
      projectId: "penumbra",
    });

    expect(resolved).toBeNull();
  });

  it("returns null when no project id is given and the discord channel is missing", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        channels: {
          alerts: {
            kind: "discord_webhook",
            defaultWebhookUrl: "https://discord.test/api/webhooks/alerts/token",
            defaultWebhookUrlEnv: "PENUMBRA_DISCORD_ALERTS_WEBHOOK_URL",
          },
        },
      }),
      env: {},
    });

    expect(resolved).toBeNull();
  });

  it("ignores project routes entirely when no project id is provided", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        promptPolicy: "summary",
        routes: {
          projects: {
            penumbra: {
              channel: "discord",
              webhookUrl: "https://discord.test/api/webhooks/inline/token",
            },
          },
        },
      }),
      env: {},
    });

    expect(resolved).toEqual({
      channelName: "discord",
      channelKind: "discord_webhook",
      webhookUrl: "https://discord.test/api/webhooks/default/token",
      routeKey: "default",
      promptPolicy: "summary",
    });
  });
});

describe("resolveNotificationRoute identity rules", () => {
  const identities = {
    agents: {
      codex: { displayName: "Penumbra / Codex" },
      gemini: { avatarUrl: "https://example.com/gemini.png" },
      claude: {
        avatarUrl: "https://example.com/claude.png",
        avatarUrlEnv: "PENUMBRA_DISCORD_AVATAR_CODEX_URL",
      },
      opencode: { avatarUrlEnv: "PENUMBRA_DISCORD_AVATAR_CODEX_URL" },
      blank: {},
    },
  };

  it("omits avatar_url when only displayName is configured", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {},
      agentKey: "codex",
    });

    expect(resolved?.identity).toEqual({ username: "Penumbra / Codex" });
  });

  it("omits username when only avatarUrl is configured", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {},
      agentKey: "gemini",
    });

    expect(resolved?.identity).toEqual({ avatar_url: "https://example.com/gemini.png" });
  });

  it("prefers the inline avatarUrl over the avatarUrlEnv value", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {
        PENUMBRA_DISCORD_AVATAR_CODEX_URL: "https://example.com/env-avatar.png",
      },
      agentKey: "claude",
    });

    expect(resolved?.identity).toEqual({ avatar_url: "https://example.com/claude.png" });
  });

  it("resolves the avatar from avatarUrlEnv when no inline avatarUrl is set", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {
        PENUMBRA_DISCORD_AVATAR_CODEX_URL: "https://example.com/opencode.png",
      },
      agentKey: "opencode",
    });

    expect(resolved?.identity).toEqual({ avatar_url: "https://example.com/opencode.png" });
  });

  it("returns undefined identity for an unknown agent key", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {},
      agentKey: "unknown-agent",
    });

    expect(resolved?.identity).toBeUndefined();
  });

  it("returns undefined identity when the entry has neither a name nor an avatar", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {},
      agentKey: "blank",
    });

    expect(resolved?.identity).toBeUndefined();
  });

  it("omits identity entirely when no agent key is provided", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({ identities }),
      env: {},
    });

    expect(resolved?.identity).toBeUndefined();
  });
});

describe("resolveNotificationRoute prompt policy precedence", () => {
  it("lets the route promptPolicy win over includePrompt and the global policy", () => {
    const resolved = resolveNotificationRoute({
      config: baseConfig({
        promptPolicy: "always",
        routes: {
          projects: {
            penumbra: {
              channel: "discord",
              includePrompt: true,
              promptPolicy: "never",
            },
          },
        },
      }),
      env: {},
      projectId: "penumbra",
    });

    expect(resolved?.promptPolicy).toBe("never");
  });
});
