import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError, type ZodType } from "zod";

import type { AgentChatConfig } from "./agentchat-types.js";

import { AgentsConfigSchema } from "./agents.js";
import { assertHandBilledSeatsWhitelisted } from "./billing-gate.js";
import { existsPath, readUtf8 } from "./node-fs.js";
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
    .flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${[...issue.path, key].join(".")}: ${issue.message}`);
      }
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
  if (!existsPath(filePath)) {
    throw new Error(`loadAgentChatConfigFromDir: ${filePath} not found`);
  }

  try {
    const content = readUtf8(filePath);
    const parsed: unknown = parseYaml(content);
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
  assertHandBilledSeatsWhitelistedWithPrefix(agentsConfig.agents, join(absDir, "agents.yaml"));
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

export function assertHandBilledSeatsWhitelistedWithPrefix(
  agents: Parameters<typeof assertHandBilledSeatsWhitelisted>[0],
  filePath: string,
): void {
  try {
    assertHandBilledSeatsWhitelisted(agents);
  } catch (error) {
    throw new Error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function reloadAgentChatConfig(): void {
  cache.clear();
}
