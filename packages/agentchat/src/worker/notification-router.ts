import type { PromptPolicy, RuntimeNotificationConfig } from "./notification-config.js";

export interface NotificationRouteResolution {
  channelName: string;
  channelKind: "discord_webhook";
  webhookUrl: string;
  routeKey: string;
  promptPolicy: PromptPolicy;
  identity?: {
    username?: string;
    avatar_url?: string;
  };
}

export interface ResolveNotificationRouteInput {
  config: RuntimeNotificationConfig;
  env: Record<string, string | undefined>;
  projectId?: string;
  agentKey?: string;
}

function resolveWebhookUrl(input: {
  env: Record<string, string | undefined>;
  webhookUrlEnv?: string;
  defaultWebhookUrl?: string;
}): string | undefined {
  if (input.webhookUrlEnv) {
    const resolved = input.env[input.webhookUrlEnv];
    if (resolved) return resolved;
  }
  return input.defaultWebhookUrl;
}

function resolvePromptPolicy(opts: {
  globalPromptPolicy: PromptPolicy;
  routePromptPolicy?: PromptPolicy;
  includePrompt?: boolean;
}): PromptPolicy {
  if (opts.routePromptPolicy) return opts.routePromptPolicy;
  if (opts.includePrompt) return "always";
  return opts.globalPromptPolicy;
}

function resolveIdentity(input: {
  env: Record<string, string | undefined>;
  agentKey?: string;
  config: RuntimeNotificationConfig;
}): NotificationRouteResolution["identity"] {
  if (!input.agentKey) return undefined;

  const identity = input.config.identities.agents[input.agentKey];
  if (!identity) return undefined;

  const username = identity.displayName;
  const avatar_url =
    identity.avatarUrl ?? (identity.avatarUrlEnv ? input.env[identity.avatarUrlEnv] : undefined);

  if (!username && !avatar_url) return undefined;

  return {
    ...(username ? { username } : {}),
    ...(avatar_url ? { avatar_url } : {}),
  };
}

export function resolveNotificationRoute(
  input: ResolveNotificationRouteInput,
): NotificationRouteResolution | null {
  if (!input.config.enabled) return null;

  const route = input.projectId ? input.config.routes.projects[input.projectId] : undefined;
  const channelName = route?.channel ?? "discord";
  const channel = input.config.channels[channelName];
  if (!channel || channel.kind !== "discord_webhook") return null;

  const routeWebhookUrl =
    route?.webhookUrl ?? (route?.webhookUrlEnv ? input.env[route.webhookUrlEnv] : undefined);
  const webhookUrl =
    routeWebhookUrl ??
    resolveWebhookUrl({
      env: input.env,
      defaultWebhookUrl: channel.defaultWebhookUrl,
    });

  if (!webhookUrl) return null;

  return {
    channelName,
    channelKind: channel.kind,
    webhookUrl,
    routeKey:
      route && (routeWebhookUrl || channelName !== "discord")
        ? `project:${input.projectId}`
        : "default",
    promptPolicy: resolvePromptPolicy({
      globalPromptPolicy: input.config.promptPolicy,
      routePromptPolicy: route?.promptPolicy,
      includePrompt: route?.includePrompt,
    }),
    identity: resolveIdentity({
      env: input.env,
      agentKey: input.agentKey,
      config: input.config,
    }),
  };
}
