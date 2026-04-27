import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync as fsExistsSync } from 'node:fs';

export interface ResolveDaemonStorageRootOpts {
  explicit?: string;
  env?: Record<string, string | undefined>;
  candidates?: string[];
  existsSync?: (path: string) => boolean;
}

export function resolveDaemonStorageRoot(opts: ResolveDaemonStorageRootOpts = {}): string {
  if (opts.explicit) {
    return opts.explicit;
  }

  const env = opts.env ?? process.env;
  if (env.PENUMBRA_STORAGE_ROOT) {
    return env.PENUMBRA_STORAGE_ROOT;
  }

  const candidates = opts.candidates ?? [
    join(homedir(), '.penumbra'),
    '/tmp/penumbra-live',
  ];
  
  const exists = opts.existsSync ?? fsExistsSync;

  for (const candidate of candidates) {
    const portPath = join(candidate, 'port');
    const tokenPath = join(candidate, 'token');
    if (exists(portPath) && exists(tokenPath)) {
      return candidate;
    }
  }

  throw new Error(`penumbra daemon not found. Checked candidate paths: ${candidates.join(', ')}`);
}