import {
  fetchServedModels,
  type LocalSeatHealthLike,
  type ServedModelsFetch,
  ServedModelsProbeError,
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

export type SeatHealthState =
  | "healthy"
  | "model_missing"
  | "unauthorized"
  | "http_error"
  | "unreachable"
  | "config_error";

export interface SeatHealthRecord {
  state: SeatHealthState;
  checkedAtMs: number;
  httpStatus?: number;
}

export interface LocalSeatHealthLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface LocalSeatHealthService extends LocalSeatHealthLike {
  refresh(): Promise<void>;
  tick(): Promise<void>;
  getSeatHealth(name: string): SeatHealthRecord | undefined;
}

export interface CreateLocalSeatHealthServiceOpts {
  agents: () => readonly LocalSeatHealthAgent[];
  fetch?: ServedModelsFetch;
  now?: () => number;
  ttlMs?: number;
  probeTimeoutMs?: number;
  localHostnames?: ReadonlySet<string>;
  readFile?: (path: string) => Promise<string>;
  log?: LocalSeatHealthLog;
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
  state: SeatHealthState;
  httpStatus?: number;
};

type ProbeOutcome = { state: SeatHealthState; httpStatus?: number };

type ProbeDeps = {
  fetch: ServedModelsFetch | undefined;
  timeoutMs: number;
  readSecretFile: (path: string) => Promise<string>;
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

// A credential file that cannot be read, or a bearer file that is empty, is a
// config problem on this host, not a backend failure. Returns null in that case.
async function readProbeCredentials(
  seat: ProbeTarget,
  readSecretFile: (path: string) => Promise<string>,
): Promise<{ bearerValue: string; caPem: string } | null> {
  try {
    const bearerValue = seat.bearerFile ? (await readSecretFile(seat.bearerFile)).trim() : "";
    if (seat.bearerFile && bearerValue.length === 0) {
      return null;
    }
    const caPem = seat.caFile ? await readSecretFile(seat.caFile) : "";
    return { bearerValue, caPem };
  } catch {
    return null;
  }
}

// TLS failures are deliberately folded into "unreachable": Bun fetch error codes vary.
function classifyProbeError(error: unknown): ProbeOutcome {
  if (error instanceof ServedModelsProbeError) {
    if (error.status === 401 || error.status === 403) {
      return { state: "unauthorized", httpStatus: error.status };
    }
    return { state: "http_error", httpStatus: error.status };
  }
  return { state: "unreachable" };
}

async function probeSeat(seat: ProbeTarget, deps: ProbeDeps): Promise<ProbeOutcome> {
  const credentials = await readProbeCredentials(seat, deps.readSecretFile);
  if (credentials === null) {
    return { state: "config_error" };
  }
  try {
    const servedModels = await fetchServedModels(seat.baseUrl, {
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      ...(credentials.bearerValue.length > 0 ? { bearerToken: credentials.bearerValue } : {}),
      ...(credentials.caPem.length > 0 ? { caPem: credentials.caPem } : {}),
    });
    if (seat.model !== null && !servedModels.has(seat.model)) {
      return { state: "model_missing" };
    }
    return { state: "healthy" };
  } catch (error) {
    return classifyProbeError(error);
  }
}

// Logs only transitions: into a failing state from healthy or from no prior
// probe (warn), and from a failing state back to healthy (info). Never logs
// file contents or the bearer value.
function logSeatTransition(
  log: LocalSeatHealthLog | undefined,
  agent: string,
  previous: HealthCacheEntry | undefined,
  next: HealthCacheEntry,
): void {
  if (!log) {
    return;
  }
  const previousState = previous?.state;
  if (next.state !== "healthy") {
    if (previousState === undefined || previousState === "healthy") {
      log.warn(
        {
          event: "local_seat_health_failing",
          agent,
          state: next.state,
          http_status: next.httpStatus ?? null,
        },
        "local seat health: seat backend probe is failing",
      );
    }
    return;
  }
  if (previousState !== undefined && previousState !== "healthy") {
    log.info(
      {
        event: "local_seat_health_recovered",
        agent,
        state: next.state,
        previous_state: previousState,
      },
      "local seat health: seat backend probe recovered",
    );
  }
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
    const outcome = await probeSeat(seat, {
      fetch: opts.fetch,
      timeoutMs: probeTimeoutMs,
      readSecretFile,
    });
    // Read the previous entry after the probe, so overlapping refreshes of the
    // same seat compare against the latest record and log a transition once.
    const previous = cache.get(seat.name);
    const next: HealthCacheEntry = {
      checkedAtMs,
      healthy: outcome.state === "healthy",
      state: outcome.state,
      ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
    };
    cache.set(seat.name, next);
    logSeatTransition(opts.log, seat.name, previous, next);
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
    getSeatHealth(name: string): SeatHealthRecord | undefined {
      const cached = cache.get(name);
      if (!cached) {
        return undefined;
      }
      return {
        state: cached.state,
        checkedAtMs: cached.checkedAtMs,
        ...(cached.httpStatus === undefined ? {} : { httpStatus: cached.httpStatus }),
      };
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
