import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildServices, loadSqliteVec, migrate, resolveEmbedder, BundledEmbedder } from '@penumbra/core';
import { loadConfig } from '@penumbra/agentchat/src/config/load.js';
import { readSiriusEnv } from './sirius-env.js';
import { serve, type DaemonHandle } from '@penumbra/daemon';

export interface RunStartOpts {
  storageRoot: string;
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

    // Load agent registry
    let agentRegistry: string[] | null = null;
    const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
    if (existsSync(configPath)) {
      try {
        const config = loadConfig(configPath);
        agentRegistry = config.agents.map((a) => a.name);
      } catch (err) {
        // Log warning but don't fail startup; validation will be skipped or fail late.
        console.warn(`penumbra: failed to load agentchat config from ${configPath}: ${err}`);
      }
    }

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      db,
      embedder,
      agentRegistry,
    });
    if (preferSirius && !sirius) {
      services.log.warn(
        { hint: 'set PENUMBRA_SIRIUS_BASE_URL/TOKEN/MODEL/DIM' },
        'PENUMBRA_EMBEDDER_PREFER_SIRIUS is true but sirius env vars are incomplete; falling back to bundled embedder',
      );
    }
    services.log.info({ embedder: embedder.name, dim: embedder.dim }, 'embedder selected');

    handle = serve({ services, token, port: 0, onStop: () => { try { db.close(); } catch { /* already closed */ } } });
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
    proc = Bun.spawn(['bun', binPath, 'start'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PENUMBRA_STORAGE_ROOT: opts.storageRoot },
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
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) return { pid: proc.pid!, port, logPath };
        } catch { /* not ready yet */ }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  try { proc.kill(); } catch { /* already gone */ }
  throw new Error(`penumbra start --detach: daemon did not become ready within 10s; check ${logPath}`);
}
