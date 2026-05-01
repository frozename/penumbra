import type { AgentChatConfig, NotificationConfig } from '../config/types.js';

export type PromptPolicy = 'never' | 'summary' | 'always';

export interface RuntimeNotificationEventConfig {
  dispatch_start: boolean;
  dispatch_end: boolean;
  dispatch_failure: boolean;
  watchdog_failure: boolean;
  claim_retry: boolean;
  adapter_retry_exhausted: boolean;
  permission_requested: boolean;
  permission_decided: boolean;
  permission_expired: boolean;
  merge_result: boolean;
  cost_quota_summary: boolean;
}

export const DEFAULT_NOTIFICATION_EVENTS: RuntimeNotificationEventConfig = {
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
};

export interface RuntimeDiscordWebhookChannelConfig {
  kind: 'discord_webhook';
  defaultWebhookUrl?: string;
  defaultWebhookUrlEnv: string;
}

export interface RuntimeNotificationChannelConfig {
  discord?: RuntimeDiscordWebhookChannelConfig;
  [channelName: string]:
    | RuntimeDiscordWebhookChannelConfig
    | undefined;
}

export interface RuntimeNotificationProjectRoute {
  channel: string;
  webhookUrlEnv?: string;
  includePrompt?: boolean;
  promptPolicy?: PromptPolicy;
}

export interface RuntimeNotificationIdentity {
  displayName?: string;
  avatarUrl?: string;
  avatarUrlEnv?: string;
}

export interface RuntimeNotificationConfig {
  enabled: boolean;
  promptPolicy: PromptPolicy;
  events: RuntimeNotificationEventConfig;
  channels: RuntimeNotificationChannelConfig;
  routes: {
    projects: Record<string, RuntimeNotificationProjectRoute>;
  };
  identities: {
    agents: Record<string, RuntimeNotificationIdentity>;
  };
  summaries: {
    costQuota: {
      enabled: boolean;
      interval: 'hourly' | 'daily';
      channel: string;
    };
  };
}

export interface LoadNotificationConfigInput {
  agentchat: AgentChatConfig;
  env: Record<string, string | undefined>;
}

function envFlag(v: string | undefined): boolean {
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function resolvePromptPolicy(opts: {
  cfg?: NotificationConfig;
  includePromptEnv: boolean;
}): PromptPolicy {
  if (opts.cfg?.prompt_policy) return opts.cfg.prompt_policy;
  if (opts.includePromptEnv) return 'always';
  return 'never';
}

function resolveDiscordChannel(cfg: NotificationConfig | undefined): {
  defaultWebhookUrlEnv: string;
} {
  const channel = cfg?.channels?.discord;
  if (channel?.kind === 'discord_webhook') {
    return { defaultWebhookUrlEnv: channel.default_webhook_url_env };
  }
  return { defaultWebhookUrlEnv: 'PENUMBRA_DISCORD_WEBHOOK_URL' };
}

export function loadNotificationConfig(
  input: LoadNotificationConfigInput,
): RuntimeNotificationConfig {
  const quiet = envFlag(input.env.PENUMBRA_DISCORD_QUIET);
  const cfg = input.agentchat.notifications ?? undefined;

  const includePromptEnv = envFlag(input.env.PENUMBRA_DISCORD_INCLUDE_PROMPT);
  const promptPolicy = resolvePromptPolicy({ cfg, includePromptEnv });

  const discordChannel = resolveDiscordChannel(cfg);
  const defaultWebhookUrl = input.env[discordChannel.defaultWebhookUrlEnv];

  const enabledByConfig = cfg?.enabled ?? true;
  const hasAnyWebhook = Boolean(defaultWebhookUrl);
  const enabled = !quiet && enabledByConfig && hasAnyWebhook;

  const events: RuntimeNotificationEventConfig = {
    ...DEFAULT_NOTIFICATION_EVENTS,
    ...(cfg?.events ?? {}),
  };

  return {
    enabled,
    promptPolicy,
    events,
    channels: {
      discord: {
        kind: 'discord_webhook',
        defaultWebhookUrl,
        defaultWebhookUrlEnv: discordChannel.defaultWebhookUrlEnv,
      },
    },
    routes: {
      projects: cfg?.routes?.projects ?? {},
    },
    identities: {
      agents: cfg?.identities?.agents ?? {},
    },
    summaries: {
      costQuota: {
        enabled: cfg?.summaries?.cost_quota?.enabled ?? true,
        interval: cfg?.summaries?.cost_quota?.interval ?? 'daily',
        channel: cfg?.summaries?.cost_quota?.channel ?? 'discord',
      },
    },
  };
}

