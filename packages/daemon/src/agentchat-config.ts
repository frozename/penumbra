import type { AgentRoutingConfig, ProviderQuota } from "@penumbra/core";

import {
  type AgentChatConfig,
  AgentsConfigSchema,
  loadAgentChatConfigFromDir,
  QuotasConfigSchema,
  RoutingConfigSchema,
} from "@penumbra/config";
import { load as parseYaml } from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZodError, type ZodType } from "zod";

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

export function loadAgentChatConfigUncached(env: NodeJS.ProcessEnv = process.env): AgentChatConfig {
  const configDir = resolveAgentChatConfigPath(env);
  try {
    return {
      ...parseConfigFile(configDir, "agents.yaml", AgentsConfigSchema),
      ...parseConfigFile(configDir, "routing.yaml", RoutingConfigSchema),
      ...parseConfigFile(configDir, "quotas.yaml", QuotasConfigSchema),
    };
  } catch (error) {
    throw new Error(formatAgentChatConfigError(error));
  }
}

export function loadAgentRoutingFromConfig(cfg: AgentChatConfig): AgentRoutingConfig {
  return {
    agents: cfg.agents.map((agent) => ({
      name: agent.name,
      roles: agent.roles,
      subscription_provider: agent.subscription_provider,
      api_provider: agent.api_provider,
      pricing_mode: agent.pricing_mode,
      adapter: agent.adapter,
    })),
    default_roles: cfg.default_roles,
    role_exploration_policy: cfg.role_routing?.exploration_policy ?? "unsampled-first",
    role_routing: cfg.role_routing,
  } as AgentRoutingConfig;
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

function parseConfigFile<T>(
  dir: string,
  name: "agents.yaml" | "routing.yaml" | "quotas.yaml",
  schema: ZodType<T>,
): T {
  const filePath = join(dir, name);
  if (!existsSync(filePath)) {
    throw new Error(`loadAgentChatConfigFromDir: ${filePath} not found`);
  }

  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = parseYaml(content);
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`${filePath}: ${formatZodIssue(error)}`);
    }
    throw error;
  }
}

function formatZodIssue(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function redactSensitiveText(text: string): string {
  return text.replaceAll(
    /((?:^|[\s;,(])(?:[\w-]+\.)*(?:apiKey|token|secret)(?:\.[\w-]+)*\s*:\s*)(?:[^;,\n]+)/gi,
    (_match, prefix: string) => `${prefix}<redacted>`,
  );
}
