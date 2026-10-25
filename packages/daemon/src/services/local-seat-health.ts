import {
  fetchServedModels,
  type LocalSeatHealthLike,
  type ServedModelsFetch,
} from "@penumbra/core";
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalSeatHealthAgent {
  name: string;
  adapter?: string;
  options?: Record<string, unknown>;
  health?: {
    url: string;
    bearer_file?: string;
    ca_file?: string;
    expect_model?: string;
  };
}

export interface LocalSeatHealthService extends LocalSeatHealthLike {
  refresh(): Promise<void>;
  tick(): Promise<void>;
}

export interface CreateLocalSeatHealthServiceOpts {
  agents: () => readonly LocalSeatHealthAgent[];
  fetch?: ServedModelsFetch;
  now?: () => number;
  ttlMs?: number;
  probeTimeoutMs?: number;
  localHostnames?: ReadonlySet<string>;
  readFile?: (path: string) => Promise<string>;
}

type ProbeTarget = {
  name: string;
  baseUrl: string;
  model: string | null;
  bearerFile: string | null;
  caFile: string | null;
};

type HealthCacheEntry = {
  checkedAtMs: number;
  healthy: boolean;
};

export const LOCAL_SEAT_HEALTH_TTL_MS = 20_000;

function localHostnamesFromEnv(): Set<string> {
  return new Set(
    (process.env.PENUMBRA_LOCAL_NODE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isLocalModelHost(
  hostname: string,
  configuredLocalHostnames: ReadonlySet<string> = localHostnamesFromEnv(),
): boolean {
  const host = hostname.toLowerCase();
  if (configuredLocalHostnames.has(host)) return true;
  if (host === "localhost" || host === "::1") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.endsWith(".local")) return true;
  return false;
}

function localOpenAiCompatSeat(
  agent: LocalSeatHealthAgent,
  configuredLocalHostnames: ReadonlySet<string>,
): ProbeTarget | null {
  if (agent.adapter !== "openai-compat-http") return null;
  const options = agent.options ?? {};
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : null;
  const model = typeof options.model === "string" ? options.model : null;
  if (!baseUrl || !model) return null;
  try {
    if (!isLocalModelHost(new URL(baseUrl).hostname, configuredLocalHostnames)) return null;
  } catch {
    return null;
  }
  return { name: agent.name, baseUrl, model, bearerFile: null, caFile: null };
}

// A seat that declares a `health` target is probed regardless of adapter or host:
// the declaration is the opt-in, and role_routing.local_seat_health_gate still
// decides whether the results affect routing.
function probeTargetFor(
  agent: LocalSeatHealthAgent,
  configuredLocalHostnames: ReadonlySet<string>,
): ProbeTarget | null {
  const health = agent.health;
  if (typeof health?.url === "string" && health.url.length > 0) {
    const options = agent.options ?? {};
    const model =
      health.expect_model ??
      (agent.adapter === "openai-compat-http" && typeof options.model === "string"
        ? options.model
        : null);
    return {
      name: agent.name,
      baseUrl: health.url,
      model,
      bearerFile: health.bearer_file ?? null,
      caFile: health.ca_file ?? null,
    };
  }
  return localOpenAiCompatSeat(agent, configuredLocalHostnames);
}

export function createLocalSeatHealthService(
  opts: CreateLocalSeatHealthServiceOpts,
): LocalSeatHealthService {
  const cache = new Map<string, HealthCacheEntry>();
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LOCAL_SEAT_HEALTH_TTL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const localHostnames = opts.localHostnames ?? localHostnamesFromEnv();
  const readFileImpl =
    opts.readFile ?? ((path: string): Promise<string> => fsReadFile(path, "utf8"));
  const localSeats = (): ProbeTarget[] =>
    opts
      .agents()
      .map((agent) => probeTargetFor(agent, localHostnames))
      .filter((seat): seat is ProbeTarget => seat !== null);

  const hasFreshHealthyProbe = (agentName: string): boolean => {
    const cached = cache.get(agentName);
    return cached?.healthy === true && now() - cached.checkedAtMs < ttlMs;
  };

  const readSecretFile = async (path: string): Promise<string> => {
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    return await readFileImpl(expanded);
  };

  const refreshSeat = async (seat: ProbeTarget, checkedAtMs: number): Promise<void> => {
    try {
      const bearerToken = seat.bearerFile ? (await readSecretFile(seat.bearerFile)).trim() : "";
      if (seat.bearerFile && bearerToken.length === 0) {
        throw new Error("bearer file resolved to an empty token");
      }
      const caPem = seat.caFile ? await readSecretFile(seat.caFile) : "";
      const servedModels = await fetchServedModels(seat.baseUrl, {
        fetch: opts.fetch,
        timeoutMs: probeTimeoutMs,
        ...(bearerToken.length > 0 ? { bearerToken } : {}),
        ...(caPem.length > 0 ? { caPem } : {}),
      });
      cache.set(seat.name, {
        checkedAtMs,
        healthy: seat.model === null ? true : servedModels.has(seat.model),
      });
    } catch {
      cache.set(seat.name, { checkedAtMs, healthy: false });
    }
  };

  return {
    getUnhealthyAgents(): ReadonlySet<string> {
      const unhealthy = new Set<string>();
      for (const seat of localSeats()) {
        if (!hasFreshHealthyProbe(seat.name)) {
          unhealthy.add(seat.name);
        }
      }
      return unhealthy;
    },
    async refresh(): Promise<void> {
      const checkedAtMs = now();
      await Promise.all(
        localSeats().map(async (seat) => {
          const cached = cache.get(seat.name);
          if (cached && checkedAtMs - cached.checkedAtMs < ttlMs) return;
          await refreshSeat(seat, checkedAtMs);
        }),
      );
    },
    tick(): Promise<void> {
      return this.refresh();
    },
  };
}
