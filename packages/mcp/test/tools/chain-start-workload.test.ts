import { beforeEach, expect, mock, test } from "bun:test";
import {
  chainStartHandler,
  resetChainStartTaskTypeDeprecationForTests,
} from "../../src/tools/chain-start.js";

beforeEach(() => {
  resetChainStartTaskTypeDeprecationForTests();
});

test("chain_start workload-only dispatches identically to task_type-only", async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: "conv-1", handoff_id: "h-1" }),
  } as any;
  const handler = chainStartHandler(daemon, { logger: { info: mock() } });

  await handler({ initial_agent: "executor", message: "run it", workload: "implement_small" });
  await handler({ initial_agent: "executor", message: "run it", task_type: "implement_small" });

  expect((daemon.startChain as any).mock.calls[0]?.[0]).toEqual(
    (daemon.startChain as any).mock.calls[1]?.[0],
  );
});

test("chain_start allows matching workload and task_type", async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: "conv-1", handoff_id: "h-1" }),
  } as any;
  const handler = chainStartHandler(daemon, { logger: { info: mock() } });

  await handler({
    initial_agent: "executor",
    message: "run it",
    workload: "implement_small",
    task_type: "implement_small",
  });

  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "run it",
    task_type: "implement_small",
  });
});

test("chain_start rejects conflicting workload and task_type with both values in message", async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: "conv-1", handoff_id: "h-1" }),
  } as any;
  const handler = chainStartHandler(daemon);

  await expect(
    handler({
      initial_agent: "executor",
      message: "run it",
      workload: "implement_small",
      task_type: "review_adversarial",
    }),
  ).rejects.toThrow(
    "chain_start: workload='implement_small' conflicts with task_type='review_adversarial'; pass only one or matching values",
  );
  expect(daemon.startChain).not.toHaveBeenCalled();
});

test("chain_start task_type-only logs deprecation once per process", async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: "conv-1", handoff_id: "h-1" }),
  } as any;
  const logger = { info: mock() };
  const handler = chainStartHandler(daemon, { logger });

  await handler({ initial_agent: "executor", message: "run it", task_type: "implement_small" });
  await handler({
    initial_agent: "executor",
    message: "run it again",
    task_type: "implement_small",
  });

  expect(logger.info).toHaveBeenCalledTimes(1);
});
