import { describe, expect, it } from 'bun:test';
import { resolveNotificationRoute } from '../../src/worker/notification-router.js';

describe('resolveNotificationRoute', () => {
  it('uses a project webhook over the default webhook', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrl: 'https://discord.test/api/webhooks/project/token',
              promptPolicy: 'never',
            },
          },
        },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });

    expect(route?.webhookUrl).toBe(
      'https://discord.test/api/webhooks/project/token',
    );
    expect(route?.channelKind).toBe('discord_webhook');
  });

  it('falls back to the default webhook for unknown projects', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: { projects: {} },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'other',
      agentName: 'codex',
    });

    expect(route?.webhookUrl).toBe(
      'https://discord.test/api/webhooks/default/token',
    );
    expect(route?.projectRouteKey).toBeNull();
  });

  it('returns null when notifications are disabled', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: false,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: { projects: {} },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });

    expect(route).toBeNull();
  });

  it('returns null when no webhook resolves', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: { kind: 'discord_webhook', defaultWebhookUrl: undefined },
        },
        routes: {
          projects: {
            penumbra: { channel: 'discord' },
          },
        },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });

    expect(route).toBeNull();
  });

  it('applies webhook username and avatar overrides for the agent', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: { projects: {} },
        identities: {
          agents: {
            codex: {
              displayName: 'Penumbra / Codex',
              avatarUrl: 'https://example.com/codex.png',
            },
          },
        },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: null,
      agentName: 'codex',
    });

    expect(route?.identity).toEqual({
      username: 'Penumbra / Codex',
      avatar_url: 'https://example.com/codex.png',
    });
  });

  it('preserves route prompt policy overrides over the global prompt policy', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'summary',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: {
          projects: {
            penumbra: {
              channel: 'discord',
              webhookUrl: 'https://discord.test/api/webhooks/project/token',
              promptPolicy: 'never',
            },
          },
        },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });

    expect(route?.promptPolicy).toBe('never');
  });

  it('matches project routes by exact project id string', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: {
            kind: 'discord_webhook',
            defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token',
          },
        },
        routes: {
          projects: {
            '#penumbra': {
              channel: 'discord',
              webhookUrl: 'https://discord.test/api/webhooks/hash/token',
            },
          },
        },
        identities: { agents: {} },
        summaries: {
          costQuota: {
            enabled: true,
            interval: 'daily',
            channel: 'discord',
          },
        },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });

    expect(route?.webhookUrl).toBe(
      'https://discord.test/api/webhooks/default/token',
    );
    expect(route?.projectRouteKey).toBeNull();
  });
});
