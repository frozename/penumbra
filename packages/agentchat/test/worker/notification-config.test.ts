import { describe, expect, it } from 'bun:test';
import { AgentChatConfigSchema } from '../../src/config/types.js';
import { loadNotificationConfig } from '../../src/worker/notification-config.js';

describe('notifications config schema', () => {
  it('accepts a channel-agnostic project route and identity mapping', () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: 'codex', adapter: 'codex-cli' }],
      notifications: {
        enabled: true,
        prompt_policy: 'never',
        channels: {
          discord: {
            kind: 'discord_webhook',
            default_webhook_url_env: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhook_url_env: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
            },
          },
        },
        identities: {
          agents: {
            codex: {
              display_name: 'Penumbra / Codex',
              avatar_url_env: 'PENUMBRA_DISCORD_AVATAR_CODEX_URL',
            },
          },
        },
      },
    });
    expect(parsed.notifications?.routes?.projects?.penumbra?.channel).toBe(
      'discord',
    );
  });
});

describe('loadNotificationConfig', () => {
  it('preserves env-only default webhook behavior when notifications block is absent', () => {
    const cfg = loadNotificationConfig({
      agentchat: {
        agents: [
          {
            name: 'codex',
            adapter: 'codex-cli',
            options: {},
            roles: [],
            auto_approve_to: [],
          },
        ],
        default_roles: {},
        providers: [],
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.channels.discord?.defaultWebhookUrl).toBe(
      'https://discord.test/api/webhooks/default/token',
    );
    expect(cfg.events.dispatch_end).toBe(true);
    expect(cfg.events.permission_decided).toBe(true);
    expect(cfg.events.cost_quota_summary).toBe(true);
    expect(cfg.promptPolicy).toBe('never');
  });

  it('quiet env disables configured routes', () => {
    const cfg = loadNotificationConfig({
      agentchat: {
        agents: [
          {
            name: 'codex',
            adapter: 'codex-cli',
            options: {},
            roles: [],
            auto_approve_to: [],
          },
        ],
        default_roles: {},
        providers: [],
        notifications: {
          enabled: true,
          channels: {
            discord: {
              kind: 'discord_webhook',
              default_webhook_url_env: 'PENUMBRA_DISCORD_WEBHOOK_URL',
            },
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
        PENUMBRA_DISCORD_QUIET: '1',
      },
    });
    expect(cfg.enabled).toBe(false);
  });
});

