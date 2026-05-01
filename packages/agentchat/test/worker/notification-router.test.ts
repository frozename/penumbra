import { describe, expect, it } from 'bun:test';
import { resolveNotificationRoute } from '../../src/worker/notification-router.js';

describe('resolveNotificationRoute', () => {
  it('returns the project route when project_id matches exactly', () => {
    const resolved = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrlEnv: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
              promptPolicy: 'summary',
            },
          },
        },
        identities: {
          agents: {
            codex: {
              displayName: 'Penumbra / Codex',
              avatarUrlEnv: 'PENUMBRA_DISCORD_AVATAR_CODEX_URL',
            },
          },
        },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
        PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL:
          'https://discord.test/api/webhooks/project/token',
        PENUMBRA_DISCORD_AVATAR_CODEX_URL:
          'https://example.com/codex.png',
      },
      projectId: 'penumbra',
      agentKey: 'codex',
    });

    expect(resolved).toEqual({
      channelName: 'discord',
      channelKind: 'discord_webhook',
      webhookUrl: 'https://discord.test/api/webhooks/project/token',
      routeKey: 'project:penumbra',
      promptPolicy: 'summary',
      identity: {
        username: 'Penumbra / Codex',
        avatar_url: 'https://example.com/codex.png',
      },
    });
  });

  it('falls back to the default webhook and route key for unknown projects', () => {
    const resolved = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'always',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrlEnv: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
            },
          },
        },
        identities: { agents: {} },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
      },
      projectId: 'unknown-project',
    });

    expect(resolved).toEqual({
      channelName: 'discord',
      channelKind: 'discord_webhook',
      webhookUrl: 'https://discord.test/api/webhooks/default/token',
      routeKey: 'default',
      promptPolicy: 'always',
    });
    expect(resolved?.routeKey).toBe('default');
  });

  it('prefers the project webhook over the default webhook', () => {
    const resolved = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrlEnv: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
            },
          },
        },
        identities: { agents: {} },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
        PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL:
          'https://discord.test/api/webhooks/project/token',
      },
      projectId: 'penumbra',
    });

    expect(resolved?.webhookUrl).toBe(
      'https://discord.test/api/webhooks/project/token',
    );
    expect(resolved?.routeKey).toBe('project:penumbra');
  });

  it('returns null when notifications are disabled or no webhook resolves', () => {
    const disabled = resolveNotificationRoute({
      config: {
        enabled: false,
        promptPolicy: 'never',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: { projects: {} },
        identities: { agents: {} },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {},
      projectId: 'penumbra',
    });

    const unresolved = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrlEnv: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
            },
          },
        },
        identities: { agents: {} },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {},
      projectId: 'penumbra',
    });

    expect(disabled).toBeNull();
    expect(unresolved).toBeNull();
  });

  it('only maps includePrompt to always when the route does not override promptPolicy', () => {
    const resolved = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'summary',
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
            defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrlEnv: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL',
              includePrompt: true,
            },
          },
        },
        identities: { agents: {} },
        events: {
          dispatch_start: false,
          dispatch_end: true,
          dispatch_failure: true,
          watchdog_failure: true,
          claim_retry: false,
          adapter_retry_exhausted: true,
          permission_requested: true,
          permission_decided: true,
          permission_expired: true,
          merge_result: true,
          cost_quota_summary: true,
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL:
          'https://discord.test/api/webhooks/default/token',
        PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL:
          'https://discord.test/api/webhooks/project/token',
      },
      projectId: 'penumbra',
    });

    expect(resolved?.promptPolicy).toBe('always');
  });
});
