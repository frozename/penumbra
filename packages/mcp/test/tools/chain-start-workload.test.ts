import { beforeEach, expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import {
  chainStartHandler,
  ChainStartInputShape,
  resetChainStartTaskTypeDeprecationForTests,
} from "../../src/tools/chain-start.js";
import { fakeDaemon } from "../helpers.js";

type StartChainFn = DaemonClient["startChain"];
type StartChainBody = Parameters<StartChainFn>[0];

beforeEach(() => {
  resetChainStartTaskTypeDeprecationForTests();
});

function makeStartChain(): { daemon: DaemonClient; startChain: StartChainFn } {
  const startChain = mock<StartChainFn>(() =>
    Promise.resolve({ conversation_id: "conv-1", handoff_id: "h-1" }),
  );
  return { daemon: fakeDaemon({ startChain }), startChain };
}

function calls(startChain: StartChainFn): StartChainBody[] {
  return (startChain as unknown as { mock: { calls: [StartChainBody][] } }).mock.calls.map(
    (entry) => entry[0],
  );
}

test("chain_start workload-only dispatches identically to task_type-only", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon, { logger: { info: mock() } });

  await handler({ initial_agent: "executor", message: "run it", workload: "implement_small" });
  await handler({ initial_agent: "executor", message: "run it", task_type: "implement_small" });

  const recorded = calls(startChain);
  expect(recorded[0]).toEqual(recorded[1] ?? {});
});

test("chain_start allows matching workload and task_type", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon, { logger: { info: mock() } });

  await handler({
    initial_agent: "executor",
    message: "run it",
    workload: "implement_small",
    task_type: "implement_small",
  });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "run it",
    task_type: "implement_small",
  });
});

test("chain_start rejects conflicting workload and task_type with both values in message", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  let caught: unknown;
  try {
    await handler({
      initial_agent: "executor",
      message: "run it",
      workload: "implement_small",
      task_type: "review_adversarial",
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(
    "chain_start: workload='implement_small' conflicts with task_type='review_adversarial'; pass only one or matching values",
  );
  expect(startChain).not.toHaveBeenCalled();
});

test("chain_start task_type-only logs deprecation once per process", async () => {
  const { daemon } = makeStartChain();
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

test("chain_start schema accepts task_type/workload and marks task_type deprecated", async () => {
  expect(ChainStartInputShape.task_type.safeParse("implement_small").success).toBe(true);
  expect(ChainStartInputShape.workload.safeParse("implement_small").success).toBe(true);

  const { daemon, startChain } = makeStartChain();
  const logger = { info: mock() };
  const handler = chainStartHandler(daemon, { logger });

  await handler({
    initial_agent: "executor",
    message: "run it",
    workload: "implement_small",
    task_type: "implement_small",
  });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "run it",
    task_type: "implement_small",
  });
  expect(logger.info).not.toHaveBeenCalled();

  const taskTypeDescription = ChainStartInputShape.task_type.description;
  expect(taskTypeDescription).toMatch(/deprecat/i);
  expect(taskTypeDescription).toMatch(/workload/i);
});
