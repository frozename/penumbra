import { dirname } from "node:path";

export interface CodexPluginOwnership {
  identifier: string;
  marketplaceName: string;
  marketplaceRoot: string;
  pluginRoot: string;
  marketplaceOwned: true;
  pluginOwned: boolean;
}

export interface CodexSetupHostResult {
  ok: boolean;
  installed?: boolean;
  detail?: string;
  ownership?: CodexPluginOwnership;
}

export interface CodexSetupHost {
  plugin: {
    state: "supported" | "unavailable" | "unknown";
    detail?: string;
    identifier?: string;
    installArgv?: string[];
    statusArgv?: string[];
    uninstallArgv?: string[];
  };
  invoke(argv: readonly string[], ownership?: CodexPluginOwnership): Promise<CodexSetupHostResult>;
}

export interface PluginRecord {
  identifier: string;
  marketplaceName?: string;
  marketplaceRoot?: string;
  pluginRoot?: string;
  marketplaceOwned?: boolean;
  pluginOwned?: boolean;
}

export type VerifiedPlugin = Required<Omit<CodexSetupHost["plugin"], "detail">> & {
  detail?: string;
};

export class CodexPluginSetupError extends Error {
  constructor(
    message: string,
    readonly state: "unavailable" | "unknown" = "unavailable",
  ) {
    super(message);
  }
}

export function requireSupportedPlugin(host: CodexSetupHost | undefined): {
  host: CodexSetupHost;
  plugin: VerifiedPlugin;
} {
  const plugin = host?.plugin;
  if (!host || plugin?.state !== "supported") {
    throw new CodexPluginSetupError(
      plugin?.detail ?? "Codex plugin installation support is unavailable",
      plugin?.state === "unknown" ? "unknown" : "unavailable",
    );
  }
  if (!plugin.identifier || !plugin.installArgv || !plugin.statusArgv || !plugin.uninstallArgv) {
    throw new CodexPluginSetupError(
      "supported plugin adapter is missing its verified identifier or argv arrays",
    );
  }
  return { host, plugin: plugin as VerifiedPlugin };
}

export function requirePluginInstalled(result: CodexSetupHostResult): void {
  if (!result.ok || result.installed !== true) {
    throw new CodexPluginSetupError(
      result.detail ?? "verified Codex plugin adapter did not confirm installation",
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function pluginOwnership(value: PluginRecord | undefined): CodexPluginOwnership | undefined {
  const candidate = record(value);
  if (
    typeof candidate?.identifier !== "string" ||
    typeof candidate.marketplaceName !== "string" ||
    typeof candidate.marketplaceRoot !== "string" ||
    typeof candidate.pluginRoot !== "string" ||
    candidate.marketplaceOwned !== true ||
    typeof candidate.pluginOwned !== "boolean"
  ) {
    return undefined;
  }
  return candidate as unknown as CodexPluginOwnership;
}

export function createPluginRecord(
  packageDir: string,
  identifier: string,
  ownership: CodexPluginOwnership | undefined,
): PluginRecord {
  if (!ownership) return { identifier };
  const verified = pluginOwnership(ownership);
  if (
    verified?.identifier !== identifier ||
    verified.marketplaceName !== "penumbra-local" ||
    verified.marketplaceRoot !== dirname(packageDir) ||
    verified.pluginRoot !== packageDir
  ) {
    throw new Error("plugin adapter returned ownership for an unexpected marketplace");
  }
  return verified;
}

export function isValidPluginRecord(value: unknown, packageDir: string): value is PluginRecord {
  const candidate = record(value);
  if (!candidate || typeof candidate.identifier !== "string" || candidate.identifier.length === 0) {
    return false;
  }
  const fields = [
    candidate.marketplaceName,
    candidate.marketplaceRoot,
    candidate.pluginRoot,
    candidate.marketplaceOwned,
    candidate.pluginOwned,
  ];
  if (fields.every((field) => field === undefined)) return true;
  const ownership = pluginOwnership(candidate as unknown as PluginRecord);
  return (
    ownership?.identifier === "penumbra@penumbra-local" &&
    ownership.marketplaceName === "penumbra-local" &&
    ownership.marketplaceRoot === dirname(packageDir) &&
    ownership.pluginRoot === packageDir
  );
}
