import {
  fetchServedModels,
  type LocalSeatHealthLike,
  type ServedModelsFetch,
} from "../../../core/src/index.js";

export interface LocalSeatHealthAgent {
  name: string;
  adapter?: string;
  options?: Record<string, unknown>;
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
}

type LocalOpenAiCompatSeat = {
  name: string;
  baseUrl: string;
  model: string;
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
): LocalOpenAiCompatSeat | null {
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
  return { name: agent.name, baseUrl, model };
}

export function createLocalSeatHealthService(
  opts: CreateLocalSeatHealthServiceOpts,
): LocalSeatHealthService {
  const cache = new Map<string, HealthCacheEntry>();
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LOCAL_SEAT_HEALTH_TTL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const localHostnames = opts.localHostnames ?? localHostnamesFromEnv();
  const localSeats = (): LocalOpenAiCompatSeat[] =>
    opts
      .agents()
      .map((agent) => localOpenAiCompatSeat(agent, localHostnames))
      .filter((seat): seat is LocalOpenAiCompatSeat => seat !== null);

  const hasFreshHealthyProbe = (agentName: string): boolean => {
    const cached = cache.get(agentName);
    return cached?.healthy === true && now() - cached.checkedAtMs < ttlMs;
  };

  const refreshSeat = async (seat: LocalOpenAiCompatSeat, checkedAtMs: number): Promise<void> => {
    try {
      const servedModels = await fetchServedModels(seat.baseUrl, {
        fetch: opts.fetch,
        timeoutMs: probeTimeoutMs,
      });
      cache.set(seat.name, {
        checkedAtMs,
        healthy: servedModels.has(seat.model),
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
