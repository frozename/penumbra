import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, resolveEmbedder, BundledEmbedder } from '@penumbra/core';
import { serve, type DaemonHandle } from '@penumbra/daemon';

export interface RunStartOpts {
  storageRoot: string;
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

    const embedder = await resolveEmbedder({
      preferSirius: process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true',
      fallback: new BundledEmbedder(),
    });

    const services = buildServices({
      env: process.env,
      input: {},
      storageRoot: opts.storageRoot,
      db,
      embedder,
    });

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
