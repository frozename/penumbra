import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

export interface ResolveWorkerIdOpts {
  flag?: string;
  envValue?: string;
  statePath?: string;
  log?: { warn: (msg: string, ...args: any[]) => void };
}

export function resolveWorkerId(opts: ResolveWorkerIdOpts = {}): string {
  if (opts.flag) {
    return opts.flag;
  }
  
  if (opts.envValue) {
    return opts.envValue;
  }

  const generateRandomId = () => 'worker-' + Math.random().toString(36).slice(2, 7);
  const defaultStatePath = join(homedir(), '.penumbra', 'worker-id');
  const statePath = opts.statePath || defaultStatePath;

  if (!statePath) {
    const id = generateRandomId();
    opts.log?.warn?.('No state path resolvable. Using transient workerId: ' + id);
    return id;
  }

  try {
    if (existsSync(statePath)) {
      const content = readFileSync(statePath, 'utf-8').trim();
      if (content) {
        return content;
      }
    }
  } catch (err: any) {
    opts.log?.warn?.('Failed to read worker-id state file at ' + statePath + ': ' + err.message);
  }

  const newId = generateRandomId();

  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(statePath, newId, { encoding: 'utf-8', mode: 0o600 });
  } catch (err: any) {
    opts.log?.warn?.('Failed to write worker-id state file at ' + statePath + ': ' + err.message + '. Using transient workerId.');
  }

  return newId;
}
