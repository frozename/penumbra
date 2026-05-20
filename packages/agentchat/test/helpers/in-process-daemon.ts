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
import { ShellSessionPool } from '@penumbra/daemon/src/services/shell-session-pool.js';
import { OrphanHandoffRecoveryService } from '@penumbra/daemon/src/services/orphan-handoff-recovery.js';
import { WatchdogService } from '@penumbra/daemon/src/services/watchdog.js';
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
  shellRun(input: {
    handoff_id: string;
    agent_name: string;
    session_id?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    pty?: boolean;
    timeout_ms?: number;
    stdin?: string;
  }): Promise<{ session_id: string; exit_code: number; stdout: string; stderr: string; truncated: boolean }>;
  shellClose(input: { handoff_id: string; session_id: string }): Promise<{ closed: boolean }>;
  shellRunRaw(input: {
    handoff_id: string;
    agent_name: string;
    session_id?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    pty?: boolean;
    timeout_ms?: number;
    stdin?: string;
  }): Promise<Response>;
  markHandoffCompleted(handoffId: string): Promise<{ handoff_id: string; status: string }>;
  markWorkerStale(workerId: string): void;
  triggerOrphanRecovery(): { requeued: number; exhausted: number };
  stop(): Promise<void>;
}

export async function startInProcessDaemon(opts: {
  shellEnabled?: boolean;
  autoApprovePermissions?: boolean;
} = {}): Promise<InProcessDaemonHarness> {
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
  // Swap the stub watchdog from buildServices for a real WatchdogService so
  // markWorkerStale (used by orphan-recovery integration tests) can poke its
  // internal heartbeat map directly.
  services.watchdog = new WatchdogService(services);
  services.watchdog.hasActiveWorker = () => true;
  (services as any).agentchatConfig = {
    agents: [
      { name: 'claude-acp-sonnet', auto_approve_to: [] },
      { name: 'local-gemma26', auto_approve_to: [] },
    ],
  };

  const shellSessionPool = opts.shellEnabled
    ? new ShellSessionPool({
      config: {
        enabled: true,
        maxSessionsPerHandoff: 4,
        maxConcurrentRunsPerSession: 1,
        maxSessionIdleMs: 600000,
        maxCommandDurationMs: 5000,
        outputByteLimit: 16384,
        redactOutput: true,
        unsetEnv: [],
        dangerousCommandsForAgent: () => ['sudo\\b'],
        redactOutputForAgent: () => true,
      },
      uuid: (() => {
        let sessionN = 0;
        return () => `sess-${++sessionN}`;
      })(),
      handoffStatusReader: {
        async getStatus(handoffId: string) {
          return services.handoffReader.get(handoffId)?.status ?? null;
        },
      },
    })
    : undefined;
  if (shellSessionPool) {
    (services as any).shellSessionPool = shellSessionPool;
    (services as any).shellConfig = {
      enabled: true,
      dangerousCommandsForAgent: () => ['sudo\\b'],
    };
  }
  if (opts.autoApprovePermissions) {
    (services as any).permissionService = {
      async requestPermission() {
        return { approved: true };
      },
    };
  }

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
    async shellRun(input) {
      const response = await fetchImpl('http://x/shell/run', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      return response.json() as Promise<{
        session_id: string;
        exit_code: number;
        stdout: string;
        stderr: string;
        truncated: boolean;
      }>;
    },
    async shellClose(input) {
      const response = await fetchImpl('http://x/shell/close', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      return response.json() as Promise<{ closed: boolean }>;
    },
    async shellRunRaw(input) {
      return fetchImpl('http://x/shell/run', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
    },
    async markHandoffCompleted(handoffId) {
      return client.completeHandoff(handoffId);
    },
    markWorkerStale(workerId) {
      // Force-age the worker's heartbeat so OrphanHandoffRecoveryService treats it as stale.
      (services.watchdog as unknown as { lastHeartbeats: Map<string, number> }).lastHeartbeats.set(workerId, 0);
    },
    triggerOrphanRecovery() {
      // staleMs=1 with the past-epoch heartbeat from markWorkerStale guarantees the worker shows stale.
      const recovery = new OrphanHandoffRecoveryService(services, { intervalMs: 0, staleMs: 1, batchSize: 100 });
      return recovery.runOnce();
    },
    async stop() {
      try {
        if (shellSessionPool) {
          await shellSessionPool.shutdown();
        }
        services.supervisor.stopAll();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
