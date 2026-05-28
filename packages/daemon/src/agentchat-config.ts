import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentChatConfigFromDir, type AgentChatConfig } from "@penumbra/config";
import type { AgentRoutingConfig, ProviderQuota } from "@penumbra/core";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "penumbra");

export function resolveAgentChatConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PENUMBRA_CONFIG_DIR;
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "penumbra");
  return DEFAULT_CONFIG_DIR;
}

export function loadAgentChatConfig(env: NodeJS.ProcessEnv = process.env): AgentChatConfig {
  const configDir = resolveAgentChatConfigPath(env);
  try {
    return loadAgentChatConfigFromDir(configDir);
  } catch (error) {
    throw new Error(formatAgentChatConfigError(error));
  }
}

export function loadAgentRoutingFromConfig(cfg: AgentChatConfig): AgentRoutingConfig {
  return {
    agents: cfg.agents.map((agent) => ({ name: agent.name, roles: agent.roles })),
    default_roles: cfg.default_roles,
    role_exploration_policy: cfg.role_routing?.exploration_policy ?? "unsampled-first",
  };
}

export function loadAgentRegistry(env: NodeJS.ProcessEnv = process.env): string[] {
  return loadAgentChatConfig(env).agents.map((agent) => agent.name);
}

export function loadAgentRouting(env: NodeJS.ProcessEnv = process.env): AgentRoutingConfig {
  return loadAgentRoutingFromConfig(loadAgentChatConfig(env));
}

export function loadProviderQuotas(env: NodeJS.ProcessEnv = process.env): ProviderQuota[] {
  const cfg = loadAgentChatConfig(env);
  return cfg.providers.map((p) => ({
    provider: p.name,
    model: p.model,
    quota_usd_per_24h: p.quota_usd_per_24h,
    quota_tokens_per_24h: p.quota_tokens_per_24h,
    quota_tokens_per_5h: p.quota_tokens_per_5h,
    pressure_caps: p.pressure_caps,
  }));
}

export function formatAgentChatConfigError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return "agentchat config invalid";
}

function redactSensitiveText(text: string): string {
  return text.replace(
    /((?:^|[\s;,(])(?:[\w-]+\.)*(?:apiKey|token|secret)(?:\.[\w-]+)*\s*:\s*)([^;,\n]+)/gi,
    (_match, prefix: string) => `${prefix}<redacted>`,
  );
}
