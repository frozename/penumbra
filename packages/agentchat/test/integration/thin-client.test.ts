import { createLogger, type HandoffRow } from "@penumbra/core";
import { expect } from "bun:test";

import type { DispatchHandoffResult } from "../../src/cli/dispatch-handoff.js";
import type { AgentChatConfig } from "../../src/config/types.js";
import type { Adapter } from "../../src/sdk/adapter.js";

import { clearCustomAdapters, registerAdapter } from "../../src/adapters/registry.js";
import { dispatchHandoff } from "../../src/cli/dispatch-handoff.js";
import { createWorkerDispatcher } from "../../src/worker/dispatcher.js";
import { startEventSource } from "../../src/worker/event-source.js";
import { serviceTest } from "../helpers/service-gates.js";
import { withDaemon } from "../helpers/with-daemon.js";

interface ChainStreamSummary {
  tokens: string;
  ended: boolean;
  maxHopsReached: boolean;
  hops: number;
}

type StreamEvent = { type?: string; delta?: string; reason?: string; next_handoff_id?: string };

function isStreamTerminal(event: StreamEvent): boolean {
  if (event.type === "chain-end") return true;
  if (event.type === "hop-end" && !event.next_handoff_id) return true;
  return false;
}

async function streamConversation(
  client: ReturnType<typeof withDaemon>["client"],
  conversationId: string,
): Promise<ChainStreamSummary> {
  let tokens = "";
  let ended = false;
  let maxHopsReached = false;
  let hops = 0;
  for await (const event of client.subscribeConversation(conversationId)) {
    if (event.type === "hop-start") hops++;
    if (event.type === "token" && typeof event.delta === "string") tokens += event.delta;
    if (event.type === "chain-end" && event.reason === "max_hops") maxHopsReached = true;
    if (isStreamTerminal(event)) {
      ended = true;
      break;
    }
  }
  return { tokens, ended, maxHopsReached, hops };
}

serviceTest(
  "--thin path integration: startChain + subscribeConversation",
  async () => {
    clearCustomAdapters();
    const { client, stop } = withDaemon();

    registerAdapter(
      "thin-test",
      (): Adapter => ({
        kind: "thin-test",
        dispatch: ({ prompt }): Promise<{ text: string }> => {
          if (prompt.includes("From @planner") || prompt.includes("From planner")) {
            return Promise.resolve({ text: "executor done" });
          }
          return Promise.resolve({ text: "plan: @executor go" });
        },
      }),
    );

    const config: AgentChatConfig = {
      agents: [
        {
          name: "planner",
          adapter: "thin-test",
          options: {},
          roles: ["planner"],
          auto_approve_to: ["executor"],
        },
        {
          name: "executor",
          adapter: "thin-test",
          options: {},
          roles: ["executor"],
          auto_approve_to: [],
        },
      ],
      default_roles: { planner: "planner", executor: "executor" },
    };

    await client.registerWorker({ worker_id: "thin-worker" });

    const dispatcher = createWorkerDispatcher({
      log: createLogger({ component: "thin-test-worker" }),
      concurrency: 1,
      claim: (id) => client.claimHandoff(id, "thin-worker"),
      postProgress: (id: string, payload: Record<string, unknown>) =>
        client.postProgress(id, payload),
      complete: async (id) => {
        await client.completeHandoff(id);
      },
      markFailed: async (id, reason): Promise<void> => {
        await client.markFailed(id, reason);
      },
      dispatch: async (h: HandoffRow, onChunk, signal): Promise<DispatchHandoffResult> => {
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
          handoff: h,
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
          onChunk,
          signal,
        });
        return result;
      },
    });

    const workerEvents = startEventSource({
      client: {
        listHandoffs: (o) => client.listHandoffs(o),
        subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
      },
      statuses: ["approved", "redirected"],
      pollIntervalMs: 50,
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

      const summary = await streamConversation(client, res.conversation_id);

      expect(summary.ended).toBe(true);
      expect(summary.hops).toBeGreaterThan(0);
      expect(summary.tokens).toContain("executor done");
      expect(summary.maxHopsReached).toBe(false);
    } finally {
      await workerEvents.stop();
      await dispatcher.idle();
      stop();
      clearCustomAdapters();
    }
  },
  10000,
);
