import {
  buildServices,
  createLogger,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { serve } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchHandoffResult } from "../../src/cli/dispatch-handoff.js";
import type { AgentChatConfig } from "../../src/config/types.js";
import type { Adapter } from "../../src/sdk/adapter.js";

import { clearCustomAdapters, registerAdapter } from "../../src/adapters/registry.js";
import { dispatchHandoff } from "../../src/cli/dispatch-handoff.js";
import { PenumbraClient } from "../../src/penumbra-client.js";
import { createWorkerDispatcher } from "../../src/worker/dispatcher.js";
import { startEventSource } from "../../src/worker/event-source.js";
import { serviceTest } from "../helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface WorkerHandle {
  dispatcher: ReturnType<typeof createWorkerDispatcher>;
  es: ReturnType<typeof startEventSource>;
}

serviceTest(
  "PHASE 2 — two workers race to claim the same approved handoff; claimDispatch ensures exactly one wins",
  async () => {
    clearCustomAdapters();
    const dir = mkdtempSync(join(tmpdir(), "penumbra-race-"));
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    let n = 0;
    const services: Services = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date("2026-04-26T00:00:00Z"),
      uuid: () => `id-${String(++n)}`,
    });
    services.agentRegistry = ["planner", "executor", "a", "b", "claude-mem"];
    services.watchdog.hasActiveWorker = (): boolean => true;
    const handle = serve({ services, token: "tok", port: 0 });
    services.watchdog.recordHeartbeat("test-worker");
    writeFileSync(join(dir, "port"), String(handle.port));
    writeFileSync(join(dir, "token"), "tok");

    let dispatchCount = 0;
    registerAdapter(
      "mock-race",
      (): Adapter => ({
        kind: "mock-race",
        dispatch: (): Promise<{ text: string }> => {
          dispatchCount++;
          return Promise.resolve({ text: "ok" });
        },
      }),
    );

    const config: AgentChatConfig = {
      agents: [{ name: "a", adapter: "mock-race", options: {}, roles: ["a"], auto_approve_to: [] }],
      default_roles: {},
    };

    const client = new PenumbraClient({ storageRoot: dir });

    const makeWorker = async (id: string): Promise<WorkerHandle> => {
      const workerClient = new PenumbraClient({ storageRoot: dir });
      await workerClient.registerWorker({ worker_id: id });
      const dispatcher = createWorkerDispatcher({
        log: createLogger({ component: id }),
        concurrency: 1,
        claim: (hid) => workerClient.claimHandoff(hid, id),
        postProgress: (hid: string, payload: Record<string, unknown>) =>
          workerClient.postProgress(hid, payload),
        complete: async (cid) => {
          await workerClient.completeHandoff(cid);
        },
        dispatch: async (h: HandoffRow): Promise<DispatchHandoffResult> => {
          const result = await dispatchHandoff({
            handoff: h,
            config,
            conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
            transcript: [],
            transcriptBudget: 4096,
            hopsSoFar: 0,
            maxHops: 5,
            trustMode: "all",
            observe: (e: Record<string, unknown>) => workerClient.observe(e),
            createHandoff: (body: Parameters<typeof workerClient.createHandoff>[0]) =>
              workerClient.createHandoff(body),
            approve: (hid2: string, body: Parameters<typeof workerClient.approve>[1]) =>
              workerClient.approve(hid2, body),
          });
          return result;
        },
      });
      const es = startEventSource({
        client: {
          listHandoffs: (o) => workerClient.listHandoffs(o),
          subscribeHandoffEvents: (o) => workerClient.subscribeHandoffEvents(o),
        },
        statuses: ["approved", "redirected"],
        pollIntervalMs: 10,
        onEvent: (row) => {
          void dispatcher.handle(row);
        },
      });
      return { dispatcher, es };
    };

    const w1 = await makeWorker("worker-1");
    const w2 = await makeWorker("worker-2");

    try {
      // 1. Create an approved handoff
      const start = await client.startChain({ initial_agent: "a", message: "go" });

      // 2. Wait for both workers to see it and try to claim it
      await new Promise((r) => setTimeout(r, 500));

      // 3. Verify: only ONE dispatch occurred
      expect(dispatchCount).toBe(1);

      // 4. Verify DB state: handoff should be completed (by the winner)
      const row = services.handoffReader.get(start.handoff_id);
      expect(row?.status).toBe("completed");
      expect(row?.worker_id).toMatch(/worker-[12]/);
    } finally {
      await w1.es.stop();
      await w2.es.stop();
      await w1.dispatcher.idle();
      await w2.dispatcher.idle();
      await handle.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      clearCustomAdapters();
    }
  },
  15000,
);
