import { type AgentConfig, CARRIER_TOOL_OPTION_KEYS } from "../files/agents.js";

/**
 * Shared managed-fields upsert discipline for config generators (llamactl
 * sync-local, and future auto-registration generators): a generator owns a
 * seat only via `provenance.source`, and on every sync it must preserve any
 * hand-edited fields on that seat while still refreshing the fields it owns.
 */

export function isGeneratorOwned(agent: AgentConfig, source: string): boolean {
  return agent.provenance?.source === source;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const PROVIDERS_SYNC_SOURCE = "providers-sync";
const CARRIER_TOOL_OPTION_PATHS = new Set<string>(
  CARRIER_TOOL_OPTION_KEYS.map((key) => `options.${key}`),
);

function safePathSegments(path: string, operation: "set" | "delete"): string[] {
  const keys = path.split(".");
  if (keys.some((key) => UNSAFE_PATH_SEGMENTS.has(key))) {
    throw new Error(`refusing to ${operation} unsafe managed field path: ${path}`);
  }
  return keys;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = safePathSegments(path, "set");
  const last = keys.pop();
  if (last === undefined) return;
  let cur = obj;
  for (const key of keys) {
    const next = cur[key];
    const clone =
      next !== null && typeof next === "object" ? { ...(next as Record<string, unknown>) } : {};
    cur[key] = clone;
    cur = clone;
  }
  cur[last] = value;
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const keys = safePathSegments(path, "delete");
  const last = keys.pop();
  if (last === undefined) return;

  let parent = obj;
  for (const key of keys) {
    const next = parent[key];
    if (next === null || typeof next !== "object") return;
    parent = next as Record<string, unknown>;
  }
  if (!Object.hasOwn(parent, last)) return;

  let cur = obj;
  for (const key of keys) {
    const clone = { ...(cur[key] as Record<string, unknown>) };
    cur[key] = clone;
    cur = clone;
  }
  Reflect.deleteProperty(cur, last);
}

function formerlyManagedCarrierToolOptionPaths(
  existing: AgentConfig,
  managedFields: readonly string[],
): string[] {
  if (existing.provenance?.source !== PROVIDERS_SYNC_SOURCE) return [];
  const nextManagedFields = new Set(managedFields);
  return (existing.provenance.managed_fields ?? []).filter(
    (path) => CARRIER_TOOL_OPTION_PATHS.has(path) && !nextManagedFields.has(path),
  );
}

/**
 * Merges a freshly generated seat onto an existing one: when there is no
 * existing seat, the generated seat is used as-is (it already carries its
 * own defaults + provenance). When an existing seat is present, every field
 * is preserved except the dot-paths listed in `managedFields`, which are
 * overwritten with the generated seat's value at that path or removed when
 * the generated value is absent.
 */
export function upsertManagedFields(
  existing: AgentConfig | undefined,
  generated: AgentConfig,
  managedFields: readonly string[],
): AgentConfig {
  if (!existing) return generated;
  const result: Record<string, unknown> = { ...existing };
  const carrierToolOptionPathsToRevoke = formerlyManagedCarrierToolOptionPaths(
    existing,
    managedFields,
  );
  for (const path of managedFields) {
    const generatedValue = getPath(generated, path);
    if (generatedValue === undefined) {
      deletePath(result, path);
    } else {
      setPath(result, path, generatedValue);
    }
  }
  for (const path of carrierToolOptionPathsToRevoke) {
    deletePath(result, path);
  }
  return result as AgentConfig;
}

export interface PruneOwnedOnlyResult {
  agents: AgentConfig[];
  prunes: string[];
}

/**
 * Drops generator-owned agents whose name is no longer in `generatedNames`
 * (their backing model vanished from discovery). Hand-authored agents, and
 * generator-owned agents still present in `generatedNames`, are kept as-is.
 */
export function pruneOwnedOnly(
  agents: readonly AgentConfig[],
  generatedNames: ReadonlySet<string>,
  source: string,
): PruneOwnedOnlyResult {
  const prunes: string[] = [];
  const kept = agents.filter((agent) => {
    if (!isGeneratorOwned(agent, source) || generatedNames.has(agent.name)) return true;
    prunes.push(agent.name);
    return false;
  });
  return { agents: kept, prunes };
}
