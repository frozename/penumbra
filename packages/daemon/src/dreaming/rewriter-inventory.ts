import {
  collectLlamactlInventory,
  type CollectLlamactlInventoryOpts,
  type LlamactlInventory,
  type LlamactlModelInventory,
  type LlmCandidate,
  type Logger,
} from "@penumbra/core";

export const DREAMING_REWRITER_INVENTORY_TTL_MS = 60_000;
export const DREAMING_REWRITER_INVENTORY_TIMEOUT_MS = 1_000;
export const DREAMING_REWRITER_LOCAL_SECONDARY_MODEL = "lfm2-generator";

const CLOUD_GATEWAY_NODE_NAMES = new Set([
  "anthropic-direct",
  "openai-direct",
  "gemini-direct",
  "groq",
  "sirius-gw",
  "embersynth-gw",
  "nvidia-nim",
]);

export interface DreamingRewriterInventory {
  collect(): Promise<LlamactlInventory>;
}

interface CachedInventoryEntry {
  checkedAtMs: number;
  inventory: LlamactlInventory;
}

let defaultInventoryCache: CachedInventoryEntry | null = null;

export function createCachedDreamingRewriterInventory(
  opts: {
    collect?: (opts?: CollectLlamactlInventoryOpts) => Promise<LlamactlInventory>;
    now?: () => number;
    ttlMs?: number;
    timeoutMs?: number;
  } = {},
): DreamingRewriterInventory {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DREAMING_REWRITER_INVENTORY_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DREAMING_REWRITER_INVENTORY_TIMEOUT_MS;
  const collect = opts.collect ?? collectLlamactlInventory;

  return {
    async collect(): Promise<LlamactlInventory> {
      const checkedAtMs = now();
      if (defaultInventoryCache && checkedAtMs - defaultInventoryCache.checkedAtMs < ttlMs) {
        return defaultInventoryCache.inventory;
      }
      const inventory = await collect({ timeoutMs });
      defaultInventoryCache = { checkedAtMs, inventory };
      return inventory;
    },
  };
}

export function resetDreamingRewriterInventoryCacheForTests(): void {
  defaultInventoryCache = null;
}

export async function resolveRewriterCandidatesAgainstInventory(opts: {
  candidates: LlmCandidate[];
  inventory?: DreamingRewriterInventory;
  log?: Logger;
}): Promise<LlmCandidate[]> {
  if (!opts.inventory || opts.candidates.length === 0) return opts.candidates;

  let inventory: LlamactlInventory;
  try {
    inventory = await opts.inventory.collect();
  } catch (err) {
    opts.log?.warn(
      { err },
      "dreaming: failed to collect llamactl inventory; using configured rewriter candidates",
    );
    return opts.candidates;
  }

  if (inventory.status === "unavailable" || inventory.models.length === 0) {
    opts.log?.warn(
      { messages: inventory.messages },
      "dreaming: llamactl inventory unavailable; using configured rewriter candidates",
    );
    return opts.candidates;
  }

  return opts.candidates.filter((candidate) =>
    inventory.models.some((model) => modelServesCandidate(model, candidate)),
  );
}

function modelServesCandidate(model: LlamactlModelInventory, candidate: LlmCandidate): boolean {
  if (!isLocalOrLanCandidate(candidate)) return false;
  if (!isLocalOrLanInventoryModel(model)) return false;
  return modelAliases(candidate.model).has(model.id);
}

function modelAliases(model: string): Set<string> {
  const aliases = new Set([model]);
  const lastSegment = model.split("/").filter(Boolean).at(-1);
  if (lastSegment) aliases.add(lastSegment);
  return aliases;
}

function isLocalOrLanCandidate(candidate: LlmCandidate): boolean {
  try {
    return isLocalOrLanHost(new URL(candidate.baseUrl).hostname);
  } catch {
    return false;
  }
}

function isLocalOrLanInventoryModel(model: LlamactlModelInventory): boolean {
  if (model.owned_by && CLOUD_GATEWAY_NODE_NAMES.has(model.owned_by.toLowerCase())) return false;
  if (model.node?.name && CLOUD_GATEWAY_NODE_NAMES.has(model.node.name.toLowerCase())) return false;
  if (!model.node?.endpoint) return true;
  try {
    return isLocalOrLanHost(new URL(model.node.endpoint).hostname);
  } catch {
    return false;
  }
}

function isLocalOrLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
  if (host === "localhost" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = 0, b = 0] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}
