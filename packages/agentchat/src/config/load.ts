// packages/agentchat/src/config/load.ts
import { load as parseYaml } from "js-yaml";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { colonFormToSdkPattern } from "../worker/mcp-tool-name.js";
import {
  AgentChatConfigSchema,
  type LongLivedConfigWithPrecomputedAllowlist,
  type ParsedAgentChatConfig,
} from "./types.js";

export function loadConfig(path: string): ParsedAgentChatConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const result = AgentChatConfigSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`agentchat config invalid: ${message}`);
  }
  return stampPrecomputedAllowlist(result.data);
}

/**
 * Load the worker config from the split config DIRECTORY the daemon reads
 * (`~/.config/penumbra/{agents,routing,quotas}.yaml`). The three files are
 * shallow-merged (the same shape `loadAgentChatConfigFromDir` in @penumbra/config
 * produces) and parsed/stamped through the SAME worker schema + allowlist
 * stamping as `loadConfig`, so worker behavior is identical to the legacy single
 * `agentchat.yaml`. This is the single-source-of-truth path: both worker and
 * daemon read the same split dir.
 */
export function loadConfigFromDir(dir: string): ParsedAgentChatConfig {
  const merged = {
    ...(parseYaml(readFileSync(join(dir, "agents.yaml"), "utf8")) as Record<string, unknown>),
    ...(parseYaml(readFileSync(join(dir, "routing.yaml"), "utf8")) as Record<string, unknown>),
    ...(parseYaml(readFileSync(join(dir, "quotas.yaml"), "utf8")) as Record<string, unknown>),
  };
  const result = AgentChatConfigSchema.safeParse(merged);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`agentchat config (split dir ${dir}) invalid: ${message}`);
  }
  return stampPrecomputedAllowlist(result.data);
}

// Worker entrypoint for the single-source split config dir — routes to dir or file loader.
/**
 * Dispatch on whether `pathOrDir` is a directory (split config dir) or a file
 * (legacy single agentchat.yaml). Lets `AGENTCHAT_CONFIG` keep pointing at a
 * single file for overrides/tests while the default resolves the split dir.
 */
export function loadConfigPathOrDir(pathOrDir: string): ParsedAgentChatConfig {
  let isDir = false;
  try {
    isDir = statSync(pathOrDir).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir ? loadConfigFromDir(pathOrDir) : loadConfig(pathOrDir);
}

function stampPrecomputedAllowlist(config: ParsedAgentChatConfig): ParsedAgentChatConfig {
  return {
    ...config,
    agents: config.agents.map((agent) => {
      const longLivedConfig = agent.long_lived_config;
      if (!longLivedConfig) return agent;
      const precomputed: LongLivedConfigWithPrecomputedAllowlist = {
        ...longLivedConfig,
        mcp_allowlist_sdk_patterns: longLivedConfig.mcp_allowlist.map((entry) =>
          colonFormToSdkPattern(entry),
        ),
      };
      return { ...agent, long_lived_config: precomputed };
    }),
  };
}
