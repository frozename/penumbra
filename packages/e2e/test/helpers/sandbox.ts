import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS. Idempotent;
// safe to run at module load even if no Database is opened by these helpers.
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

export interface Sandbox {
  /** Absolute path to a fresh tmp dir. */
  dir: string;
  /** Recursively delete the dir. Idempotent. */
  cleanup(): void;
}

export function makeSandbox(prefix = 'penumbra-e2e-'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let cleaned = false;
  return {
    dir,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
