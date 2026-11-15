import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import {
  fetchServedModelEntries,
  type ServedModelEntry,
  type ServedModelsFetch,
} from "./served-models-client.js";

const execFileAsync = promisify(execFileCb);
const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:7944";

export interface LlamactlNodeInventory {
  name: string;
  endpoint: string;
  certificatePem?: string;
  fingerprint?: string;
  token?: string;
  healthy?: boolean;
  kind?: "gateway";
}

export interface LlamactlModelInventory {
  id: string;
  owned_by?: string;
  created?: number;
  experimental?: boolean;
  node?: LlamactlNodeInventory;
}

export interface LlamactlInventory {
  status: "ok" | "partial" | "unavailable";
  messages: string[];
  nodes: LlamactlNodeInventory[];
  models: LlamactlModelInventory[];
  catalog?: unknown[];
}

export interface CollectLlamactlInventoryOpts {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  fetch?: ServedModelsFetch;
  execFile?: (
    file: string,
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  proxyBaseUrl?: string;
  timeoutMs?: number;
  includeLocalGateways?: boolean;
  includeCatalog?: boolean;
}

interface KubeConfigShape {
  apiVersion?: unknown;
  currentContext?: unknown;
  clusters?: {
    name?: unknown;
    nodes?: {
      name?: unknown;
      kind?: unknown;
      endpoint?: unknown;
      certificate?: unknown;
      certificateFingerprint?: unknown;
      cloud?: { provider?: unknown; baseUrl?: unknown; apiKeyRef?: unknown };
    }[];
    cluster?: {
      server?: unknown;
      "certificate-authority-data"?: unknown;
      "certificate-authority"?: unknown;
      fingerprint?: unknown;
      kind?: unknown;
      extensions?: { name?: unknown; extension?: Record<string, unknown> }[];
    };
  }[];
  contexts?: {
    name?: unknown;
    cluster?: unknown;
    user?: unknown;
    context?: { cluster?: unknown; user?: unknown };
  }[];
  users?: { name?: unknown; token?: unknown; user?: { token?: unknown } }[];
}

function resolveKubeconfigCandidates(env: Record<string, string | undefined>): string[] {
  if (env.LLAMACTL_CONFIG?.trim()) return [env.LLAMACTL_CONFIG.trim()];
  const home = env.HOME?.trim();
  const storage = env.DEV_STORAGE?.trim();
  return [
    join(storage?.length ? storage : join(home?.length ? home : homedir(), ".llamactl"), "config"),
  ];
}

function decodeCertificatePem(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function extensionValue(
  cluster: NonNullable<KubeConfigShape["clusters"]>[number]["cluster"],
  key: string,
): unknown {
  for (const entry of cluster?.extensions ?? []) {
    const ext = entry.extension;
    if (ext && Object.hasOwn(ext, key)) return ext[key];
  }
  return undefined;
}

function isAgentCluster(
  cluster: NonNullable<KubeConfigShape["clusters"]>[number]["cluster"],
): boolean {
  const kind = cluster?.kind ?? extensionValue(cluster, "kind");
  return kind === undefined || kind === "agent";
}

function parseKubeconfigNodes(raw: string, includeLocalGateways: boolean): LlamactlNodeInventory[] {
  const parsed = parseYaml(raw) as KubeConfigShape | null;
  if (parsed?.apiVersion === "llamactl/v1")
    return parseCurrentRegistryNodes(parsed, includeLocalGateways);
  const contextsByCluster = collectContextsByCluster(parsed);
  const tokensByUser = collectTokensByUser(parsed);
  return (parsed?.clusters ?? []).flatMap((entry) =>
    parseKubeconfigNode(entry, contextsByCluster, tokensByUser),
  );
}

function parseCurrentRegistryNodes(
  parsed: KubeConfigShape,
  includeLocalGateways: boolean,
): LlamactlNodeInventory[] {
  const context = parsed.contexts?.find((entry) => entry.name === parsed.currentContext);
  const cluster = parsed.clusters?.find((entry) => entry.name === context?.cluster);
  if (!context || !cluster) return [];
  const token = parsed.users?.find((entry) => entry.name === context.user)?.token;
  return (cluster.nodes ?? []).flatMap((node): LlamactlNodeInventory[] => {
    if (typeof node.name !== "string") return [];
    if (node.cloud) return parseCurrentLocalGateway(node, includeLocalGateways);
    if (
      (node.kind !== undefined && node.kind !== "agent") ||
      typeof node.endpoint !== "string" ||
      !/^https?:\/\//.test(node.endpoint)
    )
      return [];
    return [
      {
        name: node.name,
        endpoint: node.endpoint,
        ...(typeof node.certificate === "string" ? { certificatePem: node.certificate } : {}),
        ...(typeof node.certificateFingerprint === "string"
          ? { fingerprint: node.certificateFingerprint }
          : {}),
        ...(typeof token === "string" ? { token } : {}),
      },
    ];
  });
}

function parseCurrentLocalGateway(
  node: NonNullable<NonNullable<KubeConfigShape["clusters"]>[number]["nodes"]>[number],
  enabled: boolean,
): LlamactlNodeInventory[] {
  const cloud = node.cloud;
  if (
    !enabled ||
    !cloud ||
    typeof node.name !== "string" ||
    typeof cloud.baseUrl !== "string" ||
    (node.kind !== undefined && node.kind !== "gateway" && node.kind !== "cloud") ||
    cloud.provider !== "openai-compatible" ||
    cloud.apiKeyRef !== undefined
  )
    return [];
  try {
    const url = new URL(cloud.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return [];
    return [{ name: node.name, endpoint: cloud.baseUrl, kind: "gateway" }];
  } catch {
    return [];
  }
}

function collectContextsByCluster(parsed: KubeConfigShape | null): Map<string, string> {
  const contexts = new Map<string, string>();
  for (const context of parsed?.contexts ?? []) {
    const cluster = context.context?.cluster;
    const user = context.context?.user;
    if (typeof cluster === "string" && typeof user === "string") contexts.set(cluster, user);
  }
  return contexts;
}

function collectTokensByUser(parsed: KubeConfigShape | null): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const user of parsed?.users ?? []) {
    if (typeof user.name === "string" && typeof user.user?.token === "string") {
      tokens.set(user.name, user.user.token);
    }
  }
  return tokens;
}

function parseKubeconfigNode(
  entry: NonNullable<KubeConfigShape["clusters"]>[number],
  contextsByCluster: Map<string, string>,
  tokensByUser: Map<string, string>,
): LlamactlNodeInventory[] {
  if (typeof entry.name !== "string" || !entry.cluster || !isAgentCluster(entry.cluster)) return [];
  const endpoint = entry.cluster.server;
  if (typeof endpoint !== "string" || endpoint.length === 0) return [];
  const user = contextsByCluster.get(entry.name);
  const fingerprint = entry.cluster.fingerprint ?? extensionValue(entry.cluster, "fingerprint");
  const token = user && tokensByUser.has(user) ? tokensByUser.get(user) : undefined;
  return [
    {
      name: entry.name,
      endpoint,
      ...(decodeCertificatePem(entry.cluster["certificate-authority-data"]) !== undefined
        ? { certificatePem: decodeCertificatePem(entry.cluster["certificate-authority-data"]) }
        : {}),
      ...(typeof fingerprint === "string" ? { fingerprint } : {}),
      ...(token === undefined ? {} : { token }),
    },
  ];
}

function aliasForServedModel(id: string): string {
  const last = id.split("/").filter(Boolean).at(-1) ?? id;
  return last;
}

// Collapses exact-duplicate rows fail-closed: if any collapsed row carried the
// experimental qualification, the kept entry carries it too.
function collapseExactIdentity(entries: ServedModelEntry[]): ServedModelEntry[] {
  const byExactIdentity = new Map<string, ServedModelEntry>();
  for (const entry of entries) {
    const exactKey = `${entry.owned_by ?? ""}\0${String(entry.created ?? "")}\0${entry.id}`;
    const kept = byExactIdentity.get(exactKey);
    if (!kept) {
      byExactIdentity.set(exactKey, { ...entry });
      continue;
    }
    if (entry.experimental === true && kept.experimental !== true) {
      byExactIdentity.set(exactKey, { ...kept, experimental: true });
    }
  }
  return [...byExactIdentity.values()];
}

function dedupeServedModels(entries: ServedModelEntry[]): ServedModelEntry[] {
  const byAlias = new Map<string, ServedModelEntry[]>();
  for (const entry of collapseExactIdentity(entries)) {
    const aliasKey = `${entry.owned_by ?? ""}\0${String(entry.created ?? "")}\0${aliasForServedModel(entry.id)}`;
    const existing = byAlias.get(aliasKey);
    if (existing) {
      existing.push(entry);
      continue;
    }
    byAlias.set(aliasKey, [entry]);
  }

  const deduped: ServedModelEntry[] = [];
  for (const entriesInAliasGroup of byAlias.values()) {
    const alias = entriesInAliasGroup.find((entry) => !entry.id.includes("/"));
    const chosen = alias ?? entriesInAliasGroup[0];
    if (!chosen) continue;
    const anyExperimental = entriesInAliasGroup.some((entry) => entry.experimental === true);
    deduped.push(
      anyExperimental && chosen.experimental !== true ? { ...chosen, experimental: true } : chosen,
    );
  }
  return deduped;
}

function appendModels(
  entries: ServedModelEntry[],
  nodes: readonly LlamactlNodeInventory[],
): LlamactlModelInventory[] {
  return dedupeServedModels(entries).map((entry) => {
    const node = nodes.find((candidate) => candidate.name === entry.owned_by) ?? nodes[0];
    return {
      id: entry.id.includes("/") ? entry.id : aliasForServedModel(entry.id),
      ...(entry.owned_by ? { owned_by: entry.owned_by } : {}),
      ...(entry.created !== undefined ? { created: entry.created } : {}),
      ...(entry.experimental === true ? { experimental: true } : {}),
      ...(node ? { node } : {}),
    };
  });
}

async function probeNodeHealth(
  node: LlamactlNodeInventory,
  fetchImpl: ServedModelsFetch,
  timeoutMs: number,
): Promise<LlamactlNodeInventory> {
  try {
    const response = await fetchImpl(`${node.endpoint.replace(/\/+$/, "")}/v1/fleet/snapshot`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(node.token ? { headers: { authorization: `Bearer ${node.token}` } } : {}),
      ...(node.certificatePem ? { tls: { ca: node.certificatePem } } : {}),
    });
    return { ...node, healthy: response.ok };
  } catch {
    return { ...node, healthy: false };
  }
}

async function readOptionalCatalog(
  execFile: CollectLlamactlInventoryOpts["execFile"],
): Promise<unknown[] | undefined> {
  try {
    const result = execFile
      ? await execFile("llamactl", ["catalog", "list", "all", "--json"])
      : await execFileAsync("llamactl", ["catalog", "list", "all", "--json"]).then((out) => ({
          ok: true,
          stdout: out.stdout,
          stderr: out.stderr,
        }));
    if (!result.ok || result.stdout.trim().length === 0) return undefined;
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function collectLlamactlInventory(
  opts: CollectLlamactlInventoryOpts = {},
): Promise<LlamactlInventory> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const messages: string[] = [];

  const nodes = readInventoryNodes(
    env,
    exists,
    readFile,
    messages,
    opts.includeLocalGateways === true,
  );

  const [healthyNodes, gateways, servedEntries, catalog] = await Promise.all([
    Promise.all(
      nodes
        .filter((node) => node.kind !== "gateway")
        .map((node) => probeNodeHealth(node, fetchImpl, timeoutMs)),
    ),
    Promise.all(
      nodes
        .filter((node) => node.kind === "gateway")
        .map((node) => probeLocalGateway(node, fetchImpl, timeoutMs, messages)),
    ),
    readServedEntries(
      opts.proxyBaseUrl ?? env.PENUMBRA_LLAMACTL_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE_URL,
      fetchImpl,
      timeoutMs,
      messages,
    ),
    opts.includeCatalog === false ? Promise.resolve(undefined) : readOptionalCatalog(opts.execFile),
  ]);
  const models = [
    ...appendModels(servedEntries, healthyNodes),
    ...gateways.flatMap((gateway) => gateway.models),
  ];
  const status: LlamactlInventory["status"] =
    models.length > 0 ? (messages.length > 0 ? "partial" : "ok") : "unavailable";
  return {
    status,
    messages,
    nodes: [...healthyNodes, ...gateways.map((gateway) => gateway.node)],
    models,
    ...(catalog ? { catalog } : {}),
  };
}

async function probeLocalGateway(
  node: LlamactlNodeInventory,
  fetchImpl: ServedModelsFetch,
  timeoutMs: number,
  messages: string[],
): Promise<{ node: LlamactlNodeInventory; models: LlamactlModelInventory[] }> {
  try {
    const entries = await fetchServedModelEntries(node.endpoint, {
      fetch: fetchImpl,
      timeoutMs,
      redirect: "error",
    });
    const healthyNode = { ...node, healthy: true };
    return { node: healthyNode, models: appendModels(entries, [healthyNode]) };
  } catch {
    messages.push(`registered local catalog unavailable: ${node.name}`);
    return { node: { ...node, healthy: false }, models: [] };
  }
}

function readInventoryNodes(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
  messages: string[],
  includeLocalGateways: boolean,
): LlamactlNodeInventory[] {
  const path = resolveKubeconfigCandidates(env).find((candidate) => exists(candidate));
  if (!path) {
    messages.push("kubeconfig not found");
    return [];
  }
  try {
    return parseKubeconfigNodes(readFile(path), includeLocalGateways);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    messages.push(`kubeconfig parse failed: ${message}`);
    return [];
  }
}

async function readServedEntries(
  proxyBaseUrl: string,
  fetchImpl: ServedModelsFetch,
  timeoutMs: number,
  messages: string[],
): Promise<ServedModelEntry[]> {
  try {
    return await fetchServedModelEntries(proxyBaseUrl, { fetch: fetchImpl, timeoutMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    messages.push(`served models unavailable: ${message}`);
    return [];
  }
}
