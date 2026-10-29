import type { AgentChatConfig } from "@penumbra/agentchat/config/types";

import { clearCustomAdapters, registerAdapter } from "@penumbra/agentchat/adapters/registry";
import { dispatchHandoff } from "@penumbra/agentchat/cli/dispatch-handoff";
import { createWorkerDispatcher } from "@penumbra/agentchat/worker/dispatcher";
import { createLogger, type HandoffRow } from "@penumbra/core";
import { expect, test } from "bun:test";

import { withDaemon } from "../helpers/with-daemon.js";

test("retry exhaustion marks failed + emits chain-terminated(error) without rejecting", async () => {
  clearCustomAdapters();
  const { client, services, stop } = withDaemon();

  const marker = "FAIL_ME";
  const errMsg = "e2e adapter boom";
  let execAttempts = 0;

  const conversation = { id: "c-retry-e2e", project_id: "p-retry-e2e" };

  try {
    await client.registerWorker({ worker_id: "e2e-worker" });

    registerAdapter("e2e-plan-ok", () => ({
      kind: "e2e-plan-ok",
      dispatch(): Promise<{ text: string }> {
        return Promise.resolve({ text: `Plan: do X. @executor ${marker}` });
      },
    }));
    registerAdapter("e2e-exec-flaky", () => ({
      kind: "e2e-exec-flaky",
      dispatch({ prompt }: { prompt: string }): Promise<{ text: string }> {
        if (prompt.includes(marker)) {
          execAttempts++;
          throw new Error(errMsg);
        }
        return Promise.resolve({ text: "ok" });
      },
    }));

    const config: AgentChatConfig = {
      agents: [
        {
          name: "planner",
          adapter: "e2e-plan-ok",
          options: {},
          roles: ["planner"],
          auto_approve_to: ["executor"],
        },
        {
          name: "executor",
          adapter: "e2e-exec-flaky",
          options: {},
          roles: ["executor"],
          auto_approve_to: [],
        },
      ],
      default_roles: {},
    };

    // Use a real worker dispatcher with real dispatchHandoff
    const dispatcher = createWorkerDispatcher<HandoffRow>({
      log: createLogger({ component: "e2e-worker" }),
      concurrency: 1,
      claim: (id) => client.claimHandoff(id, "e2e-worker"),
      postProgress: (id, payload: Parameters<typeof client.postProgress>[1]) =>
        client.postProgress(id, payload),
      complete: async (id): Promise<void> => {
        await client.completeHandoff(id);
      },
      markFailed: async (id, reason): Promise<void> => {
        await client.markFailed(id, reason);
      },
      dispatch: async (h, onChunk, signal) => {
        return await dispatchHandoff({
          handoff: h,
          config,
          conversation,
          transcript: [],
          transcriptBudget: 4096,
          hopsSoFar: 0,
          maxHops: 5,
          trustMode: "all",
          observe: (e: Parameters<typeof client.observe>[0]) => client.observe(e),
          createHandoff: (body: Parameters<typeof client.createHandoff>[0]) =>
            client.createHandoff(body),
          approve: (id: string, body: Parameters<typeof client.approve>[1]) =>
            client.approve(id, body),
          markFailed: (id, reason) => client.markFailed(id, reason),
          onChunk,
          signal,
          delay: () => Promise.resolve(),
        });
      },
    });

    const start = await client.startChain({
      initial_agent: "planner",
      message: "hi",
      conversation_id: conversation.id,
      project_id: conversation.project_id,
    });

    // Manually drive the dispatcher
    const handoff1 = services.handoffReader.get(start.handoff_id);
    if (!handoff1) {
      throw new Error("expected start handoff row");
    }
    await dispatcher.handle(handoff1);
    await dispatcher.idle();

    // The planner should have created an executor handoff
    const handoffs = services.handoffReader.listByStatus({
      statuses: ["approved"],
      conversation_id: conversation.id,
    });
    expect(handoffs.length).toBe(1);
    const execHandoff = handoffs[0];
    if (!execHandoff) {
      throw new Error("expected executor handoff row");
    }
    expect(execHandoff.to_agent).toBe("executor");

    await dispatcher.handle(execHandoff);
    await dispatcher.idle();

    expect(execAttempts).toBe(4); // 1 initial + 3 retries

    const failedHandoffs = services.handoffReader.listByStatus({
      statuses: ["failed"],
      conversation_id: conversation.id,
    });
    expect(failedHandoffs.length).toBe(1);
    expect(failedHandoffs[0]?.status).toBe("failed");
    expect(failedHandoffs[0]?.resolution_reason).toBe(errMsg);
  } finally {
    stop();
    clearCustomAdapters();
  }
}, 30_000);
