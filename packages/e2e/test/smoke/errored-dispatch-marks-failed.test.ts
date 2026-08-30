import { createWorkerDispatcher } from "@penumbra/agentchat/worker/dispatcher";
import { createLogger } from "@penumbra/core";
import { expect, test } from "bun:test";

import { withDaemon } from "../helpers/with-daemon.js";

// Regression: an errored dispatch must NOT be durably marked completed. The
// worker dispatcher previously called complete() in its finally block
// regardless of outcome, so a thrown/errored dispatch masked the failure as a
// success and suppressed retry/recovery. The corrected behavior routes error
// outcomes through markFailed(), leaving the row failed (recoverable).
test("thrown dispatch leaves the handoff failed, not completed (worker + daemon)", async () => {
  const { client, services, stop } = withDaemon();
  const conversation = { id: "c-errored-dispatch", project_id: "p-errored-dispatch" };
  const errMsg = "adapter crashed mid-dispatch";

  try {
    await client.registerWorker({ worker_id: "errored-worker" });

    const dispatcher = createWorkerDispatcher({
      log: createLogger({ component: "errored-worker" }),
      concurrency: 1,
      claim: (id) => client.claimHandoff(id, "errored-worker"),
      postProgress: (id, payload: Parameters<typeof client.postProgress>[1]) =>
        client.postProgress(id, payload),
      complete: async (id): Promise<void> => {
        await client.completeHandoff(id, "errored-worker");
      },
      markFailed: async (id, reason): Promise<void> => {
        await client.markFailed(id, reason, "errored-worker");
      },
      // Simulate an adapter exception that escapes dispatchHandoff entirely.
      dispatch: (): Promise<never> => Promise.reject(new Error(errMsg)),
    });

    const start = await client.startChain({
      initial_agent: "planner",
      message: "trigger an errored dispatch",
      conversation_id: conversation.id,
      project_id: conversation.project_id,
    });

    const handoff = services.handoffReader.get(start.handoff_id);
    expect(handoff).not.toBeNull();
    await dispatcher.handle(handoff!);
    await dispatcher.idle();

    const row = services.handoffReader.get(start.handoff_id);
    expect(row?.status).toBe("failed");
    expect(row?.status).not.toBe("completed");
    expect(row?.resolution_reason).toBe(errMsg);
  } finally {
    stop();
  }
}, 30_000);
