import type { AgentConfig } from "../config/types.js";
import { colonFormToSdkPattern } from "../worker/mcp-tool-name.js";

export type AdapterOptions = Record<string, unknown>;

export function normalizeAdapterOptions(
  cfg: { options?: AgentConfig["options"] },
  hostedSpecs: readonly {
    name: string;
    command: string;
    args?: readonly string[];
    env?: readonly { name: string; value: string }[];
  }[],
  allowlist: readonly string[],
): AdapterOptions {
  let adapterOptions = (cfg.options ?? {}) as AdapterOptions;
  adapterOptions = normalizeWarmPoolOptions(adapterOptions);

  if (hostedSpecs.length > 0) {
    const yamlMcpServers: any[] = Array.isArray(adapterOptions.mcpServers)
      ? (adapterOptions.mcpServers as any[])
      : [];
    const yamlNames = new Set(yamlMcpServers.map((s: any) => s.name));
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
  const mapping: Array<[string, string]> = [
    ["warm_pool", "warmPool"],
    ["warm_pool_idle_grace_ms", "warmPoolIdleGraceMs"],
    ["warm_pool_max_age_ms", "warmPoolMaxAgeMs"],
    ["warm_pool_max_entries", "warmPoolMaxEntries"],
  ];
  for (const [from, to] of mapping) {
    if (mapped[from] !== undefined && mapped[to] === undefined) {
      mapped[to] = mapped[from];
    }
  }
  return mapped;
}
