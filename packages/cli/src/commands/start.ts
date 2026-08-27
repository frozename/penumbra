import type { AgentRoutingConfig, Logger, ProviderQuota } from "@penumbra/core";

import { loadShellConfig } from "@penumbra/agentchat/worker/shell-config";
import {
  applyRuntimePragmas,
  assertEmbedderDim,
  buildServices,
  BundledEmbedder,
  defaultProjectRegistryPath,
  loadProjectRegistry,
  loadSqliteVec,
  migrate,
  resolveEmbedder,
} from "@penumbra/core";
import { buildRegistry as buildWorkflowRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStorageDbPath } from "../../../core/src/db/storage-db-path.js";
import {
  loadAgentChatConfig,
  loadAgentRoutingFromConfig,
  resolveAgentChatConfigPath,
} from "../../../daemon/src/agentchat-config.js";
import { type DaemonHandle, serve } from "../../../daemon/src/serve.js";
import { InProcessPermissionService } from "../../../daemon/src/services/in-process-permission-service.js";
import { ShellSessionPool } from "../../../daemon/src/services/shell-session-pool.js";
import { createWorkflowRunsRegistry } from "../../../daemon/src/services/workflow-runs-registry.js";
import { wrapDatabaseWithSlowQueryLog } from "../../../daemon/src/slow-query.js";
import { isBilledHandSeatViolation } from "@penumbra/config";
import { readEmbedderEnv } from "./sirius-env.js";

const { resolveLegacyOperatorConfigPath, resolveOperatorConfigPath } = createRequire(
  import.meta.url,
)("../../../config/src/files/operator-paths.js") as {
  resolveLegacyOperatorConfigPath: (
    filename: string,
    env: Record<string, string | undefined>,
  ) => string;
  resolveOperatorConfigPath: (filename: string, env: Record<string, string | undefined>) => string;
};

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return (
    value !== "" &&
    value !== "0" &&
    value.toLowerCase() !== "false" &&
    value.toLowerCase() !== "off" &&
    value.toLowerCase() !== "no"
  );
}

function resolveSlowQueryThreshold(): number {
  const raw = process.env.PENUMBRA_SLOW_QUERY_THRESHOLD_MS;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
}

async function buildWorkflowRegistrySafe(workflowDirs: {
  playbooksDir: string;
  workflowsDir: string;
}): Promise<Awaited<ReturnType<typeof buildWorkflowRegistry>> | undefined> {
  try {
    return await buildWorkflowRegistry(workflowDirs);
  } catch (err) {
    process.stderr.write(
      `penumbra: failed to build workflow registry: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

type RuntimeServicesExtras = {
  shellConfig?: ReturnType<typeof loadShellConfig>;
  shellSessionPool?: ShellSessionPool;
  agentchatConfig?: ReturnType<typeof loadAgentChatConfig>;
};

function wireShellSessionPool(
  runtimeServices: RuntimeServicesExtras,
  services: ReturnType<typeof buildServices>,
  agentchatConfig: ReturnType<typeof loadAgentChatConfig> | null,
): (() => void) | undefined {
  if (!agentchatConfig) return undefined;
  const shellConfig = loadShellConfig({ agentchat: agentchatConfig });
  runtimeServices.shellConfig = shellConfig;
  runtimeServices.agentchatConfig = agentchatConfig;
  if (!shellConfig.enabled) return undefined;
  const shellSessionPool = new ShellSessionPool({
    config: shellConfig,
    uuid: (): string => crypto.randomUUID(),
    handoffStatusReader: {
      getStatus: (handoffId): Promise<string | null> =>
        Promise.resolve(services.handoffReader.get(handoffId)?.status ?? null),
    },
  });
  runtimeServices.shellSessionPool = shellSessionPool;
  const timer = setInterval((): void => {
    void shellSessionPool.reapTerminalHandoffs();
    void shellSessionPool.reapIdleSessions();
  }, 30_000);
  return (): void => {
    clearInterval(timer);
    void shellSessionPool.shutdown();
  };
}

interface AgentchatBundle {
  agentRegistry: string[] | null;
  agentRouting: AgentRoutingConfig | null;
  providerQuotas: ProviderQuota[];
  agentchatConfig: ReturnType<typeof loadAgentChatConfig> | null;
}

function loadAgentchatBundle(): AgentchatBundle {
  const configPath = resolveAgentChatConfigPath(process.env);
  if (!existsSync(configPath)) {
    return { agentRegistry: null, agentRouting: null, providerQuotas: [], agentchatConfig: null };
  }
  try {
    const agentchatConfig = loadAgentChatConfig(process.env);
    return {
      agentchatConfig,
      agentRegistry: agentchatConfig.agents.map((agent) => agent.name),
      agentRouting: loadAgentRoutingFromConfig(agentchatConfig),
      providerQuotas: agentchatConfig.providers.map((provider) => ({
        provider: provider.name,
        model: provider.model,
        quota_usd_per_24h: provider.quota_usd_per_24h,
        quota_tokens_per_24h: provider.quota_tokens_per_24h,
        quota_tokens_per_5h: provider.quota_tokens_per_5h,
        pressure_caps: provider.pressure_caps,
      })),
    };
  } catch (err) {
    if (handleAgentchatConfigLoadError(err)) {
      throw err;
    }
    process.stderr.write(
      `penumbra: failed to load agentchat config from ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { agentRegistry: null, agentRouting: null, providerQuotas: [], agentchatConfig: null };
  }
}

export function handleAgentchatConfigLoadError(error: unknown): boolean {
  if (isBilledHandSeatViolation(error)) {
    throw error;
  }
  return false;
}

function warnLegacyOperatorConfigFiles(): void {
  for (const filename of ["projects.yaml", "workers.yaml"] as const) {
    const legacyPath = resolveLegacyOperatorConfigPath(filename, process.env);
    const currentPath = resolveOperatorConfigPath(filename, process.env);
    if (!existsSync(legacyPath) || legacyPath === currentPath) continue;
    process.stderr.write(
      `penumbra: WARN legacy ${filename} found at ${legacyPath}; move it to ${currentPath} or run 'penumbra config split --source-dir ${dirname(legacyPath)} --dest ${dirname(currentPath)}'\n`,
    );
  }
}

export interface RunStartOpts {
  storageRoot: string;
  host?: string;
  /**
   * Explicit TCP port to bind. Default `0` lets the OS pick an ephemeral port
   * (the historical behavior). Pinning to a fixed port keeps OTel hook configs
   * (claude / codex / gemini settings) valid across daemon restarts — every
   * boot would otherwise pick a new port and silently invalidate them.
   */
  port?: number;
}

export interface RunStartDetachedResult {
  pid: number;
  port: number;
  logPath: string;
}

export async function runStart(opts: RunStartOpts): Promise<DaemonHandle> {
  const pidPath = join(opts.storageRoot, "pid");
  const portPath = join(opts.storageRoot, "port");

  claimPidFile(pidPath);
  warnLegacyOperatorConfigFiles();

  const token = readFileSync(join(opts.storageRoot, "token"), "utf8").trim();
  const dbPath = resolveStorageDbPath(opts.storageRoot);
  const rawDb = new Database(dbPath);

  const slowQueryThreshold = resolveSlowQueryThreshold();
  let activeLog: Logger | undefined;
  const slowLogger: Pick<Logger, "warn"> = {
    warn: (obj: unknown, msg?: string): void => {
      if (activeLog) activeLog.warn(obj as Record<string, unknown>, msg);
      else process.stderr.write(`${msg ?? ""} ${JSON.stringify(obj)}\n`);
    },
  };
  const db = wrapDatabaseWithSlowQueryLog(rawDb, slowQueryThreshold, slowLogger as Logger);

  let handle: DaemonHandle | undefined;
  try {
    loadSqliteVec(db);
    applyRuntimePragmas(db);

    const embedderEnv = readEmbedderEnv(process.env) ?? { mode: "auto" as const };
    const embedder = await resolveEmbedder({
      mode: embedderEnv.mode,
      remote: embedderEnv.remote,
      fallback: new BundledEmbedder(),
    });
    migrate(db, { embeddingDim: embedder.dim });
    assertEmbedderDim(db, embedder.dim, embedder.name);

    const loadedAgentchat = loadAgentchatBundle();
    const { agentRegistry, agentRouting, providerQuotas, agentchatConfig } = loadedAgentchat;

    const repoRoot = process.cwd();
    const workflowDirs = {
      playbooksDir: join(repoRoot, "plugin/playbooks"),
      workflowsDir: join(repoRoot, "plugin/workflows"),
    };
    const workflowRegistry = await buildWorkflowRegistrySafe(workflowDirs);

    const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
    const projectRegistry = loadProjectRegistry(projectRegistryPath);

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      reviewsDir: process.env.PENUMBRA_REVIEWS_DIR ?? resolve(process.cwd(), ".penumbra/reviews"),
      db,
      embedder,
      agentRegistry,
      agentRouting,
      providerQuotas,
      workflowRegistry,
      projectRegistry,
    });
    activeLog = services.log;
    const runtimeServices = services as typeof services & {
      shellConfig?: ReturnType<typeof loadShellConfig>;
      shellSessionPool?: ShellSessionPool;
      agentchatConfig?: ReturnType<typeof loadAgentChatConfig>;
      permissionService?: InProcessPermissionService;
      workflowDirs?: { playbooksDir: string; workflowsDir: string };
    };
    const runtimeServicesWithWorkflowRuns = runtimeServices;
    runtimeServicesWithWorkflowRuns.workflowRuns = createWorkflowRunsRegistry({
      uuid: () => services.uuid(),
      clock: () => services.clock(),
      db,
      storageRoot: opts.storageRoot,
    });
    if (
      isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH) &&
      runtimeServices.workflowRuns === undefined
    ) {
      throw new Error(
        "strict-mode (PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH=1) requires services.workflowRuns to be wired; check daemon startup",
      );
    }
    runtimeServices.workflowDirs = workflowDirs;
    const permissionService = new InProcessPermissionService(services);
    permissionService.start();
    runtimeServices.permissionService = permissionService;
    services.subscriptionPressureCache.start();
    const stopShellSweeper = wireShellSessionPool(runtimeServices, services, agentchatConfig);
    services.log.info({ embedder: embedder.name, dim: embedder.dim }, "embedder selected");

    handle = serve({
      services,
      token,
      port: opts.port ?? 0,
      hostname: resolveDaemonHost(opts.host),
      onStop: () => {
        stopShellSweeper?.();
        services.subscriptionPressureCache.stop();
        permissionService.stop();
        try {
          db.close();
        } catch {
          /* already closed */
        }
      },
    });
    writeFileSync(portPath, `${String(handle.port)}\n`, { mode: 0o644 });
    services.log.info({ pid: process.pid, port: handle.port }, "penumbra running");
    return handle;
  } catch (err) {
    cleanupAfterFailedStart(handle, db, pidPath, portPath);
    throw err;
  }
}

function cleanupAfterFailedStart(
  handle: DaemonHandle | undefined,
  db: Database,
  pidPath: string,
  portPath: string,
): void {
  if (handle) {
    void handle.stop();
  } else {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  try {
    unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(portPath);
  } catch {
    /* never written */
  }
}

function claimPidFile(pidPath: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(pidPath, "wx");
      try {
        writeSync(fd, `${String(process.pid)}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // EEXIST: someone else has the file. Check liveness.
    const existing = Number(readFileSync(pidPath, "utf8"));
    if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
      throw new Error(`penumbra already running (pid=${String(existing)})`);
    }

    // Stale. Best-effort takeover. unlink+open('wx') still has a tiny race
    // window if another stale-takeover runs concurrently, so retry a bounded
    // number of times and re-check liveness each time.
    try {
      unlinkSync(pidPath);
    } catch {
      /* concurrent winner already removed it */
    }
  }
  throw new Error("failed to claim pid file after concurrent takeover");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runStartDetached(opts: RunStartOpts): Promise<RunStartDetachedResult> {
  const binPath = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
  const logPath = join(opts.storageRoot, "log");
  const portPath = join(opts.storageRoot, "port");
  const pidPath = join(opts.storageRoot, "pid");
  const hostname = resolveDaemonHost(opts.host);

  // Stop here if a live daemon already exists; lets us mirror runStart's
  // contract instead of relying on the child process to discover EEXIST and
  // exit non-zero asynchronously.
  if (existsSync(pidPath)) {
    const existing = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
      throw new Error(`penumbra already running (pid=${String(existing)})`);
    }
  }

  const logFd = openSync(logPath, "a");
  let proc;
  try {
    const childArgs = ["bun", binPath, "start"];
    if (opts.port !== undefined) {
      childArgs.push("--port", String(opts.port));
    }
    proc = Bun.spawn(childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        PENUMBRA_STORAGE_ROOT: opts.storageRoot,
        ...(opts.host ? { PENUMBRA_DAEMON_HOST: opts.host } : {}),
      },
    });
    proc.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await probeDaemonReady(hostname, portPath);
    if (ready !== null) return { pid: proc.pid, port: ready, logPath };
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  throw new Error(
    `penumbra start --detach: daemon did not become ready within 10s; check ${logPath}`,
  );
}

async function probeDaemonReady(hostname: string, portPath: string): Promise<number | null> {
  if (!existsSync(portPath)) return null;
  const port = Number(readFileSync(portPath, "utf8").trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const res = await fetch(`http://${resolveHealthcheckHost(hostname)}:${String(port)}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) return port;
  } catch {
    /* not ready yet */
  }
  return null;
}

function resolveDaemonHost(host?: string): string {
  const trimmed = host?.trim();
  if (trimmed) return trimmed;
  const fromEnv = process.env.PENUMBRA_DAEMON_HOST?.trim();
  if (fromEnv) return fromEnv;
  return "127.0.0.1";
}

function resolveHealthcheckHost(hostname: string): string {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}
