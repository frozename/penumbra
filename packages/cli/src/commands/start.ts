import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServices, loadSqliteVec, migrate, resolveEmbedder, BundledEmbedder } from '@penumbra/core';
import { buildRegistry as buildWorkflowRegistry } from '@penumbra/workflows';
import { loadShellConfig } from '@penumbra/agentchat/worker/shell-config';
import { readSiriusEnv } from './sirius-env.js';
import { ShellSessionPool } from '../../../daemon/src/services/shell-session-pool.js';
import { InProcessPermissionService } from '../../../daemon/src/services/in-process-permission-service.js';
import { serve, type DaemonHandle } from '../../../daemon/src/serve.js';
import { loadAgentChatConfig, resolveAgentChatConfigPath } from '../../../daemon/src/agentchat-config.js';
import { defaultProjectRegistryPath, loadProjectRegistry } from '@penumbra/core';
import type { AgentRoutingConfig, ProviderQuota } from '@penumbra/core';

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
  const pidPath = join(opts.storageRoot, 'pid');
  const portPath = join(opts.storageRoot, 'port');

  claimPidFile(pidPath);

  const token = readFileSync(join(opts.storageRoot, 'token'), 'utf8').trim();
  const dbPath = join(opts.storageRoot, 'db.sqlite');
  const db = new Database(dbPath);
  let handle: DaemonHandle | undefined;
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const preferSirius = process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true';
    const sirius = preferSirius ? readSiriusEnv(process.env) : undefined;
    const embedder = await resolveEmbedder({
      preferSirius,
      sirius,
      fallback: new BundledEmbedder(),
    });

    // Load agent registry + provider quotas from the same agentchat.yaml.
    let agentRegistry: string[] | null = null;
    let agentRouting: AgentRoutingConfig | null = null;
    let providerQuotas: ProviderQuota[] = [];
    let agentchatConfig: ReturnType<typeof loadAgentChatConfig> | null = null;
    const configPath = resolveAgentChatConfigPath(process.env);
    if (existsSync(configPath)) {
      try {
        agentchatConfig = loadAgentChatConfig(configPath);
        agentRegistry = agentchatConfig.agents.map((agent) => agent.name);
        agentRouting = {
          agents: agentchatConfig.agents.map((agent) => ({ name: agent.name, roles: agent.roles })),
          default_roles: agentchatConfig.default_roles,
          role_exploration_policy: agentchatConfig.role_routing?.exploration_policy ?? 'unsampled-first',
        };
        providerQuotas = agentchatConfig.providers.map((provider) => ({
          provider: provider.name,
          model: provider.model,
          quota_usd_per_24h: provider.quota_usd_per_24h,
          quota_tokens_per_24h: provider.quota_tokens_per_24h,
          quota_tokens_per_5h: provider.quota_tokens_per_5h,
          pressure_caps: provider.pressure_caps,
        }));
      } catch (err) {
        // Log warning but don't fail startup; validation will be skipped or fail late.
        console.warn(`penumbra: failed to load agentchat config from ${configPath}: ${err}`);
      }
    }

    const repoRoot = process.cwd();
    const workflowDirs = {
      playbooksDir: join(repoRoot, 'plugin/playbooks'),
      workflowsDir: join(repoRoot, 'plugin/workflows'),
    };
    let workflowRegistry: Awaited<ReturnType<typeof buildWorkflowRegistry>> | undefined;
    try {
      workflowRegistry = await buildWorkflowRegistry(workflowDirs);
    } catch (err) {
      console.warn(`penumbra: failed to build workflow registry: ${err}`);
    }

    const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
    const projectRegistry = loadProjectRegistry(projectRegistryPath);

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      db,
      embedder,
      agentRegistry,
      agentRouting,
      providerQuotas,
      workflowRegistry,
      projectRegistry,
    });
    const runtimeServices = services as typeof services & {
      shellConfig?: ReturnType<typeof loadShellConfig>;
      shellSessionPool?: ShellSessionPool;
      agentchatConfig?: ReturnType<typeof loadAgentChatConfig>;
      permissionService?: InProcessPermissionService;
      workflowDirs?: { playbooksDir: string; workflowsDir: string };
    };
    runtimeServices.workflowDirs = workflowDirs;
    const permissionService = new InProcessPermissionService(services);
    permissionService.start();
    runtimeServices.permissionService = permissionService;
    services.subscriptionPressureCache.start();
    let stopShellSweeper: (() => void) | undefined;
    if (agentchatConfig) {
      const shellConfig = loadShellConfig({ agentchat: agentchatConfig });
      runtimeServices.shellConfig = shellConfig;
      runtimeServices.agentchatConfig = agentchatConfig;
      if (shellConfig.enabled) {
        const shellSessionPool = new ShellSessionPool({
          config: shellConfig,
          uuid: () => crypto.randomUUID(),
          handoffStatusReader: {
            getStatus: async (handoffId) => services.handoffReader.get(handoffId)?.status ?? null,
          },
        });
        runtimeServices.shellSessionPool = shellSessionPool;
        const timer = setInterval(() => {
          void shellSessionPool.reapTerminalHandoffs();
          void shellSessionPool.reapIdleSessions();
        }, 30_000);
        stopShellSweeper = () => {
          clearInterval(timer);
          void shellSessionPool.shutdown();
        };
      }
    }
    if (preferSirius && !sirius) {
      services.log.warn(
        { hint: 'set PENUMBRA_SIRIUS_BASE_URL/TOKEN/MODEL/DIM' },
        'PENUMBRA_EMBEDDER_PREFER_SIRIUS is true but sirius env vars are incomplete; falling back to bundled embedder',
      );
    }
    services.log.info({ embedder: embedder.name, dim: embedder.dim }, 'embedder selected');

    handle = serve({
      services,
      token,
      port: opts.port ?? 0,
      hostname: resolveDaemonHost(opts.host),
      onStop: () => {
        stopShellSweeper?.();
        services.subscriptionPressureCache.stop();
        permissionService.stop();
        try { db.close(); } catch { /* already closed */ }
      },
    });
    writeFileSync(portPath, `${handle.port}\n`, { mode: 0o644 });
    services.log.info({ pid: process.pid, port: handle.port }, 'penumbra running');
    return handle;
  } catch (err) {
    if (handle) {
      // handle.stop() will invoke onStop which closes db.
      handle.stop();
    } else {
      // handle was never created; close db directly.
      try { db.close(); } catch { /* already closed */ }
    }
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try { unlinkSync(portPath); } catch { /* never written */ }
    throw err;
  }
}

function claimPidFile(pidPath: string): void {
  try {
    const fd = openSync(pidPath, 'wx');
    try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // EEXIST: someone else has the file. Check liveness.
  const existing = Number(readFileSync(pidPath, 'utf8'));
  if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
    throw new Error(`penumbra already running (pid=${existing})`);
  }
  // Stale. Best-effort takeover. unlink+open('wx') still has a tiny race
  // window if another stale-takeover runs concurrently — the loser will
  // hit EEXIST again on the second openSync and retry the liveness check.
  // One retry is enough for the practical case.
  try { unlinkSync(pidPath); } catch { /* concurrent winner already removed it */ }
  const fd = openSync(pidPath, 'wx');
  try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function runStartDetached(opts: RunStartOpts): Promise<RunStartDetachedResult> {
  const binPath = fileURLToPath(new URL('../../bin/penumbra.ts', import.meta.url));
  const logPath = join(opts.storageRoot, 'log');
  const portPath = join(opts.storageRoot, 'port');
  const pidPath = join(opts.storageRoot, 'pid');
  const hostname = resolveDaemonHost(opts.host);

  // Stop here if a live daemon already exists; lets us mirror runStart's
  // contract instead of relying on the child process to discover EEXIST and
  // exit non-zero asynchronously.
  if (existsSync(pidPath)) {
    const existing = Number(readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
      throw new Error(`penumbra already running (pid=${existing})`);
    }
  }

  const logFd = openSync(logPath, 'a');
  let proc;
  try {
    const childArgs = ['bun', binPath, 'start'];
    if (opts.port !== undefined) {
      childArgs.push('--port', String(opts.port));
    }
    proc = Bun.spawn(childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
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
    if (existsSync(portPath)) {
      const port = Number(readFileSync(portPath, 'utf8').trim());
      if (Number.isInteger(port) && port > 0) {
        try {
          const res = await fetch(`http://${resolveHealthcheckHost(hostname)}:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) return { pid: proc.pid!, port, logPath };
        } catch { /* not ready yet */ }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  try { proc.kill(); } catch { /* already gone */ }
  throw new Error(`penumbra start --detach: daemon did not become ready within 10s; check ${logPath}`);
}

function resolveDaemonHost(host?: string): string {
  return host?.trim() || process.env.PENUMBRA_DAEMON_HOST?.trim() || '127.0.0.1';
}

function resolveHealthcheckHost(hostname: string): string {
  if (hostname === '0.0.0.0') return '127.0.0.1';
  if (hostname === '::') return '[::1]';
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
