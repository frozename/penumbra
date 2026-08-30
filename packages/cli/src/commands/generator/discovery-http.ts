import { execFileSync } from "node:child_process";

import type { DiscoveredModel } from "./discovery-types.js";

export interface HttpDiscoveryProviderSpec {
  providerId: string;
  baseUrl: string;
  keychainAccount: string;
}

export const DEFAULT_HTTP_PROVIDER_SPECS = [
  {
    providerId: "sakana",
    baseUrl: "https://api.sakana.ai/v1",
    keychainAccount: "llamactl/sakana",
  },
  {
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    keychainAccount: "llamactl/deepseek",
  },
] as const satisfies readonly HttpDiscoveryProviderSpec[];

export type HttpModelDiscoveryResult =
  | {
      outcome: "discovered";
      providerId: string;
      models: DiscoveredModel[];
    }
  | {
      outcome: "skipped";
      providerId: string;
      status?: number;
      reason: string;
    };

export interface DiscoverHttpModelsOpts {
  provider: HttpDiscoveryProviderSpec;
  fetch?: typeof globalThis.fetch;
  resolveKeychain?: (account: string) => string | Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseModels(payload: unknown, providerId: string): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("response must be an object with a data array");
  }

  return payload.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return [];
    const displayName =
      typeof entry.display_name === "string" && entry.display_name.length > 0
        ? entry.display_name
        : typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : entry.id;
    return [{ sourceProviderId: providerId, modelId: entry.id, displayName }];
  });
}

function defaultResolveKeychain(account: string): string {
  const slash = account.indexOf("/");
  if (slash <= 0 || slash === account.length - 1) {
    throw new Error(`invalid keychain account ${account}`);
  }

  return execFileSync(
    "security",
    ["find-generic-password", "-s", account.slice(0, slash), "-a", account.slice(slash + 1), "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function skip(providerId: string, detail: string, status?: number): HttpModelDiscoveryResult {
  return {
    outcome: "skipped",
    providerId,
    ...(status === undefined ? {} : { status }),
    reason: `${providerId} model discovery skipped: ${detail}`,
  };
}

export async function discoverHttpModels(
  opts: DiscoverHttpModelsOpts,
): Promise<HttpModelDiscoveryResult> {
  const { provider } = opts;

  try {
    const token = (
      await (opts.resolveKeychain ?? defaultResolveKeychain)(provider.keychainAccount)
    ).trim();
    if (token.length === 0) throw new Error("resolved keychain token is empty");

    const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
    const response = await (opts.fetch ?? globalThis.fetch)(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) {
      const statusText = response.statusText.trim();
      return skip(
        provider.providerId,
        `HTTP ${String(response.status)}${statusText.length === 0 ? "" : ` ${statusText}`}`,
        response.status,
      );
    }

    const models = parseModels(await response.json(), provider.providerId);
    return { outcome: "discovered", providerId: provider.providerId, models };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return skip(provider.providerId, detail);
  }
}
