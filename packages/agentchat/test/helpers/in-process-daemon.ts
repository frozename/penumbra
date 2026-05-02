import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServices,
  loadSqliteVec,
  migrate,
  type DispatchEventInput,
  type Services,
} from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../../src/penumbra-client.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

export interface InProcessDaemonHarness {
  client: PenumbraClient;
  services: Services;
  postDispatchEvent(event: DispatchEventInput): Promise<void>;
  getDispatchEvents(handoffId: string): Promise<Array<{ kind: string; meta?: Record<string, unknown> | null }>>;
  dispatchTimeline(handoffId: string): Promise<{ events: Array<{ kind: string; meta?: Record<string, unknown> | null }> }>;
  stop(): Promise<void>;
}

export async function startInProcessDaemon(): Promise<InProcessDaemonHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-agentchat-int-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-02T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  services.agentRegistry = ['claude-acp-sonnet', 'local-gemma26'];
  services.watchdog.hasActiveWorker = () => true;

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  }) as typeof fetch;

  writeFileSync(join(dir, 'port'), '1');
  writeFileSync(join(dir, 'token'), token);

  const client = new PenumbraClient({ storageRoot: dir, fetch: fetchImpl });

  return {
    client,
    services,
    async postDispatchEvent(event) {
      await client.postDispatchEvents([event]);
    },
    async getDispatchEvents(handoffId) {
      const { events } = await client.getDispatchEvents({ handoff_id: handoffId });
      return events;
    },
    async dispatchTimeline(handoffId) {
      return client.getDispatchTimeline(handoffId) as Promise<{
        events: Array<{ kind: string; meta?: Record<string, unknown> | null }>;
      }>;
    },
    async stop() {
      try {
        services.supervisor.stopAll();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
