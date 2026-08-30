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
}

export interface LlamactlModelInventory {
  id: string;
  owned_by?: string;
  created?: number;
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
}

interface KubeConfigShape {
  clusters?: {
    name?: unknown;
    cluster?: {
      server?: unknown;
      "certificate-authority-data"?: unknown;
      "certificate-authority"?: unknown;
      fingerprint?: unknown;
      kind?: unknown;
      extensions?: { name?: unknown; extension?: Record<string, unknown> }[];
    };
  }[];
  contexts?: { name?: unknown; context?: { cluster?: unknown; user?: unknown } }[];
  users?: { name?: unknown; user?: { token?: unknown } }[];
}

function resolveKubeconfigCandidates(env: Record<string, string | undefined>): string[] {
  const devStorage =
    env.DEV_STORAGE && env.DEV_STORAGE.length > 0 ? env.DEV_STORAGE : join(homedir(), "DevStorage");
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return [join(devStorage, "config"), join(home, ".llamactl", "config")];
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

function parseKubeconfigNodes(raw: string): LlamactlNodeInventory[] {
  const parsed = parseYaml(raw) as KubeConfigShape | null;
  const contextsByCluster = collectContextsByCluster(parsed);
  const tokensByUser = collectTokensByUser(parsed);
  return (parsed?.clusters ?? []).flatMap((entry) =>
    parseKubeconfigNode(entry, contextsByCluster, tokensByUser),
  );
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

function dedupeServedModels(entries: ServedModelEntry[]): ServedModelEntry[] {
  const byExactIdentity = new Map<string, ServedModelEntry>();
  for (const entry of entries) {
    const exactKey = `${entry.owned_by ?? ""}\0${String(entry.created ?? "")}\0${entry.id}`;
    if (!byExactIdentity.has(exactKey)) {
      byExactIdentity.set(exactKey, entry);
    }
  }

  const byAlias = new Map<string, ServedModelEntry[]>();
  for (const entry of byExactIdentity.values()) {
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
    if (chosen) deduped.push(chosen);
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

  const nodes = readInventoryNodes(env, exists, readFile, messages);

  const healthyNodes = await Promise.all(
    nodes.map((node) => probeNodeHealth(node, fetchImpl, timeoutMs)),
  );

  const servedEntries = await readServedEntries(
    opts.proxyBaseUrl ?? env.PENUMBRA_LLAMACTL_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE_URL,
    fetchImpl,
    timeoutMs,
    messages,
  );

  const catalog = await readOptionalCatalog(opts.execFile);
  const models = appendModels(servedEntries, healthyNodes);
  const status: LlamactlInventory["status"] =
    models.length > 0 ? (messages.length > 0 ? "partial" : "ok") : "unavailable";
  return {
    status,
    messages,
    nodes: healthyNodes,
    models,
    ...(catalog ? { catalog } : {}),
  };
}

function readInventoryNodes(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
  messages: string[],
): LlamactlNodeInventory[] {
  const path = resolveKubeconfigCandidates(env).find((candidate) => exists(candidate));
  if (!path) {
    messages.push("kubeconfig not found");
    return [];
  }
  try {
    return parseKubeconfigNodes(readFile(path));
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
