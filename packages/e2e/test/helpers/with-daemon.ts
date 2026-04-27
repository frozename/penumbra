import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../../../agentchat/src/penumbra-client.js';

export function withDaemon(): {
  client: PenumbraClient;
  services: Services;
  stop: () => void;
} {
  const storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-e2e-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  services.agentRegistry = ['planner', 'executor', 'a', 'b', 'claude-mem'];
  services.watchdog.hasActiveWorker = () => true;

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  };

  writeFileSync(join(storageRoot, 'port'), '1\n');
  writeFileSync(join(storageRoot, 'token'), `${token}\n`);

  return {
    client: new PenumbraClient({ storageRoot, fetch: fetchImpl }),
    services,
    stop() {
      try {
        services.supervisor.stopAll();
      } catch {}
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}
