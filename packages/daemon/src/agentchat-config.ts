import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@penumbra/agentchat/src/config/load.js';
import type { AgentChatConfig } from '@penumbra/agentchat/src/config/types.js';
import type { AgentRoutingConfig, ProviderQuota } from '@penumbra/core';

const DEFAULT_AGENTCHAT_CONFIG_PATH = join(homedir(), '.config/agentchat/agentchat.yaml');

export function resolveAgentChatConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PENUMBRA_AGENTCHAT_CONFIG ?? DEFAULT_AGENTCHAT_CONFIG_PATH;
}

export function loadAgentChatConfig(path: string): AgentChatConfig {
  try {
    return loadConfig(path);
  } catch (error) {
    throw new Error(formatAgentChatConfigError(error));
  }
}

export function loadAgentRegistry(path: string): string[] {
  return loadAgentChatConfig(path).agents.map((agent) => agent.name);
}

export function loadAgentRouting(path: string): AgentRoutingConfig {
  const cfg = loadAgentChatConfig(path);
  return {
    agents: cfg.agents.map((agent) => ({ name: agent.name, roles: agent.roles })),
    default_roles: cfg.default_roles,
    role_exploration_policy: cfg.role_routing?.exploration_policy ?? 'unsampled-first',
  };
}

export function loadProviderQuotas(path: string): ProviderQuota[] {
  const cfg = loadAgentChatConfig(path);
  return cfg.providers.map((p) => ({
    provider: p.name,
    model: p.model,
    quota_usd_per_24h: p.quota_usd_per_24h,
    quota_tokens_per_24h: p.quota_tokens_per_24h,
    quota_tokens_per_5h: p.quota_tokens_per_5h,
  }));
}

export function formatAgentChatConfigError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return 'agentchat config invalid';
}

function redactSensitiveText(text: string): string {
  return text.replace(
    /((?:^|[\s;,(])(?:[\w-]+\.)*(?:apiKey|token|secret)(?:\.[\w-]+)*\s*:\s*)([^;,\n]+)/gi,
    (_match, prefix: string) => `${prefix}<redacted>`,
  );
}
