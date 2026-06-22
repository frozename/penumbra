import {
  buildServices,
  createLogger,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchHandoffResult } from "../../src/cli/dispatch-handoff.js";
import type { AgentChatConfig } from "../../src/config/types.js";
import type { Adapter } from "../../src/sdk/adapter.js";

import { registerAdapter } from "../../src/adapters/registry.js";
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
  /* best-effort: custom SQLite path may not exist on every dev machine */
}

serviceTest(
  "headless POST /chains/start → worker dispatches via SSE only (poll disabled)",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "penumbra-int-sse-"));
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
    const token = "tok";
    const handler = createDaemonFetchHandler({ services, token });
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return await handler(req);
    }) as typeof fetch;
    writeFileSync(join(dir, "port"), "1");
    writeFileSync(join(dir, "token"), token);

    // Stub adapter: planner mentions @executor; executor replies plain.
    let plannerCalls = 0;
    let executorCalls = 0;
    registerAdapter(
      "mock-int",
      (): Adapter => ({
        kind: "mock-int",
        dispatch: ({ prompt }): Promise<{ text: string }> => {
          if (prompt.includes("From @planner")) {
            executorCalls++;
            return Promise.resolve({ text: "executor done" });
          }
          plannerCalls++;
          return Promise.resolve({ text: "plan: @executor go" });
        },
      }),
    );
    const config: AgentChatConfig = {
      agents: [
        {
          name: "planner",
          adapter: "mock-int",
          options: {},
          roles: ["planner"],
          auto_approve_to: ["executor"],
        },
        {
          name: "executor",
          adapter: "mock-int",
          options: {},
          roles: ["executor"],
          auto_approve_to: [],
        },
      ],
      default_roles: { planner: "planner", executor: "executor" },
    };

    const client = new PenumbraClient({ storageRoot: dir, fetch: fetchImpl });
    await client.registerWorker({ worker_id: "test-worker" });
    const log = createLogger({ component: "int-test" });

    const dispatcher = createWorkerDispatcher({
      log,
      concurrency: 1,
      claim: (id) => client.claimHandoff(id, "test-worker"),
      postProgress: (id: string, payload: Record<string, unknown>) =>
        client.postProgress(id, payload),
      complete: async (id) => {
        await client.completeHandoff(id);
      },
      dispatch: async (h: HandoffRow): Promise<DispatchHandoffResult> => {
        const transcript: { agent: string; text: string }[] = [];
        const { handoffs } = await client.listHandoffs({
          statuses: ["completed", "dispatched", "approved", "redirected"],
          conversation_id: h.conversation_id,
        });
        for (const x of [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts))) {
          if (x.handoff_id === h.handoff_id) continue;
          transcript.push({
            agent: x.from_agent === "user" ? "user" : x.from_agent,
            text: x.message,
          });
        }
        const hopsSoFar = transcript.filter((t) => t.agent !== "user").length;
        const result = await dispatchHandoff({
          handoff: { from_agent: h.from_agent, to_agent: h.to_agent, message: h.message },
          config,
          conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
          transcript,
          transcriptBudget: 4096,
          hopsSoFar,
          maxHops: 5,
          trustMode: h.chain_trust_mode ?? "all",
          observe: (e: Record<string, unknown>) => client.observe(e),
          createHandoff: (body: Parameters<typeof client.createHandoff>[0]) =>
            client.createHandoff(body),
          approve: (id: string, body: Parameters<typeof client.approve>[1]) =>
            client.approve(id, body),
        });
        return result;
      },
    });

    const handle = startEventSource({
      client: {
        listHandoffs: (o) => client.listHandoffs(o),
        subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
      },
      statuses: ["approved", "redirected"],
      // Disable polling by setting it to a value larger than the test timeout
      pollIntervalMs: 30000,
      onEvent: (row) => {
        void dispatcher.handle(row as HandoffRow);
      },
    });

    try {
      const res = await client.startChain({
        initial_agent: "planner",
        message: "go!",
        max_hops: 5,
        trust_mode: "all",
      });

      // Poll for completion
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { handoffs } = await client.listHandoffs({
          statuses: ["pending", "approved", "dispatched"],
          conversation_id: res.conversation_id,
        });
        if (handoffs.length === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Assertions
      expect(plannerCalls).toBe(1);
      expect(executorCalls).toBe(1);

      const events = services.db
        .query<
          { event_type: string; user_id: string },
          [string]
        >(`SELECT event_type, user_id FROM t0_events WHERE session_id=? ORDER BY ts ASC`)
        .all(res.conversation_id);
      const types = events.map((e) => e.event_type);
      expect(types.filter((t) => t === "user-prompt").length).toBe(1);
      expect(types.filter((t) => t === "agent-prompt").length).toBe(2);
      expect(types.filter((t) => t === "agent-response").length).toBe(2);
      expect(types.filter((t) => t === "agent-handoff").length).toBe(1);

      const hand = services.db
        .query<
          { status: string; from_agent: string; to_agent: string },
          [string]
        >(`SELECT status, from_agent, to_agent FROM handoffs WHERE conversation_id=? ORDER BY ts ASC`)
        .all(res.conversation_id);
      expect(hand.every((h) => h.status === "completed")).toBe(true);
    } finally {
      await handle.stop();
      await dispatcher.idle();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10000,
);
