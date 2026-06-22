import type { AgentConfig } from "../config/types.js";

import { colonFormToSdkPattern } from "../worker/mcp-tool-name.js";

export type AdapterOptions = Record<string, unknown>;

interface McpServerSpec {
  name: string;
  command: string;
  args?: readonly string[];
  env?: readonly { name: string; value: string }[];
}

function isMcpServerSpec(value: unknown): value is McpServerSpec {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

function readMcpServers(options: AdapterOptions): McpServerSpec[] {
  const raw = options.mcpServers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMcpServerSpec);
}

export function normalizeAdapterOptions(
  cfg: { options?: AgentConfig["options"] },
  hostedSpecs: readonly McpServerSpec[],
  allowlist: readonly string[],
): AdapterOptions {
  let adapterOptions: AdapterOptions = cfg.options ?? {};
  adapterOptions = normalizeWarmPoolOptions(adapterOptions);

  if (hostedSpecs.length > 0) {
    const yamlMcpServers = readMcpServers(adapterOptions);
    const yamlNames = new Set(yamlMcpServers.map((s) => s.name));
    const injected = hostedSpecs
      .filter((s) => !yamlNames.has(s.name))
      .map((s) => ({
        name: s.name,
        command: s.command,
        args: [...(s.args ?? [])],
        env: [...(s.env ?? [])],
      }));
    if (injected.length > 0) {
      adapterOptions = { ...adapterOptions, mcpServers: [...yamlMcpServers, ...injected] };
    }
  }

  if (hostedSpecs.length > 0 && !adapterOptions.claudeCodeAllowedTools) {
    const sdkPatterns =
      allowlist.length > 0
        ? allowlist.map((pattern) =>
            pattern.startsWith("mcp__") ? pattern : colonFormToSdkPattern(pattern),
          )
        : [];
    if (sdkPatterns.length > 0) {
      adapterOptions = {
        ...adapterOptions,
        claudeCodeAllowedTools: sdkPatterns,
      };
    }
  }

  return adapterOptions;
}

function normalizeWarmPoolOptions(options: AdapterOptions): AdapterOptions {
  const mapped: AdapterOptions = { ...options };
  const mapping: [string, string][] = [
    ["warm_pool", "warmPool"],
    ["warm_pool_idle_grace_ms", "warmPoolIdleGraceMs"],
    ["warm_pool_max_age_ms", "warmPoolMaxAgeMs"],
    ["warm_pool_max_entries", "warmPoolMaxEntries"],
    ["warm_pool_size", "warmPoolSize"],
    ["model_warmup_prompt", "modelWarmupPrompt"],
  ];
  for (const [from, to] of mapping) {
    if (mapped[from] !== undefined && mapped[to] === undefined) {
      mapped[to] = mapped[from];
    }
  }
  return mapped;
}
