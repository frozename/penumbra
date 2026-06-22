import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface WorkerIdLogger {
  warn: (msg: string, ...args: unknown[]) => void;
}

export interface ResolveWorkerIdOpts {
  flag?: string;
  envValue?: string;
  statePath?: string;
  log?: WorkerIdLogger;
}

function generateRandomId(): string {
  return "worker-" + Math.random().toString(36).slice(2, 7);
}

function tryReadStatePath(statePath: string, log: WorkerIdLogger | undefined): string | undefined {
  try {
    if (existsSync(statePath)) {
      const content = readFileSync(statePath, "utf-8").trim();
      if (content) return content;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn("Failed to read worker-id state file at " + statePath + ": " + msg);
  }
  return undefined;
}

function tryWriteStatePath(
  statePath: string,
  value: string,
  log: WorkerIdLogger | undefined,
): void {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(statePath, value, { encoding: "utf-8", mode: 0o600 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(
      "Failed to write worker-id state file at " +
        statePath +
        ": " +
        msg +
        ". Using transient workerId.",
    );
  }
}

export function resolveWorkerId(opts: ResolveWorkerIdOpts = {}): string {
  if (opts.flag) {
    return opts.flag;
  }

  if (opts.envValue) {
    return opts.envValue;
  }

  const defaultStatePath = join(homedir(), ".penumbra", "worker-id");
  const statePath = opts.statePath ?? defaultStatePath;

  if (!statePath) {
    const id = generateRandomId();
    opts.log?.warn("No state path resolvable. Using transient workerId: " + id);
    return id;
  }

  const existing = tryReadStatePath(statePath, opts.log);
  if (existing) return existing;

  const newId = generateRandomId();
  tryWriteStatePath(statePath, newId, opts.log);
  return newId;
}
