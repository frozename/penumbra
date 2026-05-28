import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZodError, type ZodType } from "zod";
import { parse as parseYaml } from "yaml";
import { AgentsConfigSchema } from "./agents.js";
import type { AgentChatConfig } from "./agentchat-types.js";
import { QuotasConfigSchema } from "./quotas.js";
import { RoutingConfigSchema } from "./routing.js";

const cache = new Map<string, AgentChatConfig>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function formatZodIssue(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
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

export function loadAgentChatConfigFromDir(dir: string): AgentChatConfig {
  const absDir = resolve(dir);
  const cached = cache.get(absDir);
  if (cached) {
    return cached;
  }

  const agentsConfig = parseConfigFile(absDir, "agents.yaml", AgentsConfigSchema);
  const routingConfig = parseConfigFile(absDir, "routing.yaml", RoutingConfigSchema);
  const quotasConfig = parseConfigFile(absDir, "quotas.yaml", QuotasConfigSchema);

  const merged: AgentChatConfig = {
    ...agentsConfig,
    ...routingConfig,
    ...quotasConfig,
  };
  const frozen = deepFreeze(merged);
  cache.set(absDir, frozen);
  return frozen;
}

export function reloadAgentChatConfig(): void {
  cache.clear();
}
