import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AcpInjectMessage, AcpInjectableSessionLike, AcpWorkerManagerLike } from './acp-injector.js';

export interface WorkerManagerHttpDeps {
  workerUrl?: string | null;
  token?: string;
  logWarn?: (message: string) => void;
  fetch?: typeof fetch;
}

export function createHttpWorkerManager(deps: WorkerManagerHttpDeps = {}): AcpWorkerManagerLike {
  const token = deps.token ?? process.env.PENUMBRA_TOKEN ?? '';
  const workerUrl = deps.workerUrl !== undefined ? deps.workerUrl : (process.env.PENUMBRA_WORKER_URL ?? readWorkerUrl());
  let warned = false;
  if (!workerUrl) {
    return {
      lookupSession: async () => {
        if (!warned) {
          warned = true;
          deps.logWarn?.('[serve] worker URL unavailable; ACP soft warnings will no-op');
        }
        return null;
      },
    };
  }
  return {
    lookupSession: async (handoffId: string): Promise<AcpInjectableSessionLike> => ({
      adapter: 'remote-worker',
      inject: async (message: AcpInjectMessage) => {
        const res = await (deps.fetch ?? fetch)(`${workerUrl}/sessions/${handoffId}/inject`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: message.text }),
        });
        if (!res.ok) {
          throw new Error(`worker inject ${res.status}: ${await res.text()}`);
        }
      },
    }),
  };
}

function readWorkerUrl(): string | null {
  const workerPortPath = join(homedir(), '.penumbra', 'worker-port');
  try {
    const port = readFileSync(workerPortPath, 'utf8').trim();
    if (!port) return null;
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) return null;
    return `http://127.0.0.1:${parsedPort}`;
  } catch {
    return null;
  }
}
