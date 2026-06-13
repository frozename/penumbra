// packages/agentchat/src/config/load.ts
import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import {
  AgentChatConfigSchema,
  type LongLivedConfigWithPrecomputedAllowlist,
  type ParsedAgentChatConfig,
} from "./types.js";
import { colonFormToSdkPattern } from "../worker/mcp-tool-name.js";

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
