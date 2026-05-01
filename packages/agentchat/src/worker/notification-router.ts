import type { PromptPolicy } from './notification-config.js';

interface DiscordWebhookChannelLike {
  kind: 'discord_webhook';
  defaultWebhookUrl?: string;
}

interface NotificationProjectRouteLike {
  channel?: string;
  webhookUrl?: string;
  webhookUrlEnv?: string;
  includePrompt?: boolean;
  promptPolicy?: PromptPolicy;
}

interface NotificationIdentityLike {
  displayName?: string;
  avatarUrl?: string;
  avatarUrlEnv?: string;
}

interface NotificationRouterConfigLike {
  enabled: boolean;
  promptPolicy: PromptPolicy;
  channels: Record<string, DiscordWebhookChannelLike | undefined>;
  routes: {
    projects: Record<string, NotificationProjectRouteLike | undefined>;
  };
  identities: {
    agents: Record<string, NotificationIdentityLike | undefined>;
  };
}

export interface ResolveNotificationRouteInput {
  config: NotificationRouterConfigLike;
  projectId: string | null;
  agentName: string | null;
  env?: Record<string, string | undefined>;
}

export interface ResolvedNotificationRoute {
  channelName: string;
  channelKind: 'discord_webhook';
  webhookUrl: string;
  projectRouteKey: string | null;
  promptPolicy: PromptPolicy;
  identity?: {
    username?: string;
    avatar_url?: string;
  };
}

function resolveProjectRoute(
  config: NotificationRouterConfigLike,
  projectId: string | null,
): { key: string | null; route?: NotificationProjectRouteLike } {
  if (!projectId) return { key: null };
  if (!Object.prototype.hasOwnProperty.call(config.routes.projects, projectId)) {
    return { key: null };
  }
  return {
    key: projectId,
    route: config.routes.projects[projectId],
  };
}

function resolvePromptPolicy(
  globalPromptPolicy: PromptPolicy,
  route: NotificationProjectRouteLike | undefined,
): PromptPolicy {
  if (route?.promptPolicy) return route.promptPolicy;
  if (route?.includePrompt === true) return 'always';
  return globalPromptPolicy;
}

function resolveIdentity(
  config: NotificationRouterConfigLike,
  agentName: string | null,
  env: Record<string, string | undefined>,
): ResolvedNotificationRoute['identity'] | undefined {
  if (!agentName) return undefined;

  const identity = config.identities.agents[agentName];
  if (!identity) return undefined;

  const username = identity.displayName;
  const avatarUrl = identity.avatarUrl ?? (identity.avatarUrlEnv ? env[identity.avatarUrlEnv] : undefined);

  if (!username && !avatarUrl) return undefined;
  return {
    username,
    avatar_url: avatarUrl,
  };
}

function resolveWebhookUrl(
  channel: DiscordWebhookChannelLike,
  route: NotificationProjectRouteLike | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const routeWebhookUrl = route?.webhookUrl ?? (route?.webhookUrlEnv ? env[route.webhookUrlEnv] : undefined);
  return routeWebhookUrl ?? channel.defaultWebhookUrl;
}

export function resolveNotificationRoute(
  input: ResolveNotificationRouteInput,
): ResolvedNotificationRoute | null {
  if (!input.config.enabled) return null;

  const env = input.env ?? {};
  const project = resolveProjectRoute(input.config, input.projectId);
  const channelName = project.route?.channel ?? 'discord';
  const channel = input.config.channels[channelName];
  if (!channel || channel.kind !== 'discord_webhook') return null;

  const webhookUrl = resolveWebhookUrl(channel, project.route, env);
  if (!webhookUrl) return null;

  return {
    channelName,
    channelKind: channel.kind,
    webhookUrl,
    projectRouteKey: project.key,
    promptPolicy: resolvePromptPolicy(input.config.promptPolicy, project.route),
    identity: resolveIdentity(input.config, input.agentName, env),
  };
}
