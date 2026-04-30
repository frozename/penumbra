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

export interface WaitForDaemonStorageRootOpts extends ResolveDaemonStorageRootOpts {
  /** Maximum total wait time in ms. Default 60_000. */
  timeoutMs?: number;
  /** Poll interval in ms. Default 500. */
  intervalMs?: number;
  /** Called once on the first failed attempt (lets the worker log "waiting for daemon..."). */
  onWaiting?: (candidates: string[]) => void;
  /** Override sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override clock (tests). */
  now?: () => number;
}

/**
 * Like resolveDaemonStorageRoot, but polls for up to timeoutMs until the
 * daemon's port+token files appear. Used by long-running services (e.g. the
 * agentchat-worker) that may start before the daemon at boot — instead of
 * exiting fatally and relying on launchd to respawn 30s later, the worker
 * waits politely. CLI commands keep using resolveDaemonStorageRoot so they
 * still fail fast.
 */
export async function waitForDaemonStorageRoot(
  opts: WaitForDaemonStorageRootOpts = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const explicit = opts.explicit && opts.explicit.length > 0 ? opts.explicit : opts.env?.PENUMBRA_STORAGE_ROOT;
  if (explicit) {
    return explicit;
  }

  const candidates = opts.candidates ?? [
    `${process.env.HOME ?? ''}/.penumbra`,
    '/tmp/penumbra-live',
  ];

  // First attempt — fail-fast path so we don't pay the onWaiting / sleep
  // overhead when the daemon is already up.
  try {
    return resolveDaemonStorageRoot({ ...opts, candidates });
  } catch {
    /* fall through to polling */
  }

  opts.onWaiting?.(candidates);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    try {
      return resolveDaemonStorageRoot({ ...opts, candidates });
    } catch {
      /* keep polling */
    }
  }

  // One last attempt so the thrown error surfaces with the canonical message.
  return resolveDaemonStorageRoot({ ...opts, candidates });
}