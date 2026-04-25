import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonHandle } from '@penumbra/daemon';

export interface RunStopOpts {
  storageRoot: string;
  handle?: DaemonHandle;
}

export async function runStop(opts: RunStopOpts): Promise<number> {
  opts.handle?.stop();
  for (const f of ['port', 'pid']) {
    const p = join(opts.storageRoot, f);
    if (existsSync(p)) unlinkSync(p);
  }
  // If the process is remote (no in-proc handle), signal by pid.
  if (!opts.handle) {
    const pidPath = join(opts.storageRoot, 'pid');
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
    }
  }
  return 0;
}
