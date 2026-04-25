import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, resolveEmbedder, BundledEmbedder } from '@penumbra/core';
import { serve, type DaemonHandle } from '@penumbra/daemon';

export interface RunStartOpts {
  storageRoot: string;
}

export async function runStart(opts: RunStartOpts): Promise<DaemonHandle> {
  const pidPath = join(opts.storageRoot, 'pid');
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    if (pid && isAlive(pid)) {
      throw new Error(`penumbra already running (pid=${pid})`);
    }
    unlinkSync(pidPath);
  }

  const token = readFileSync(join(opts.storageRoot, 'token'), 'utf8').trim();
  const dbPath = join(opts.storageRoot, 'db.sqlite');
  const db = new Database(dbPath);
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

  const handle = serve({ services, token, port: 0 });
  writeFileSync(join(opts.storageRoot, 'port'), `${handle.port}\n`, { mode: 0o644 });
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o644 });
  services.log.info({ pid: process.pid, port: handle.port }, 'penumbra running');
  return handle;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
