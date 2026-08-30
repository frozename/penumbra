import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { chainStartRefinedHandler } from "@src/tools/chain-start-refined.js";

import { fakeDaemon } from "../helpers.js";

type DispatchRefineFn = DaemonClient["dispatchRefine"];
type StartChainFn = DaemonClient["startChain"];
type StartChainBody = Parameters<StartChainFn>[0];
type StartChainResult = Awaited<ReturnType<StartChainFn>>;

interface CallRecord {
  refineCalls: string[];
  startChainCalls: StartChainBody[];
}

function makeDaemon(refined: string, rec: CallRecord): DaemonClient {
  const dispatchRefine: DispatchRefineFn = (message: string) => {
    rec.refineCalls.push(message);
    return Promise.resolve({ refined });
  };
  const startChain: StartChainFn = (body) => {
    rec.startChainCalls.push(body);
    const result: StartChainResult = {
      conversation_id: "conv-test",
      handoff_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      task_class: "STANDARD",
      lane_id: null,
      recalled_memory_ids: [],
    };
    return Promise.resolve(result);
  };
  return fakeDaemon({ dispatchRefine, startChain });
}

test("refines the message and forwards the rest of the chain_start input", async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon("SHORTENED.", rec);
  const handler = chainStartRefinedHandler(daemon);
  await handler({
    initial_agent: "codex-acp-fast",
    message: "# Spike\n## Background\nLong original prompt.",
    task_class: "STANDARD",
    use_worktree: false,
    max_hops: 2,
    trust_mode: "all",
  });
  expect(rec.refineCalls).toEqual(["# Spike\n## Background\nLong original prompt."]);
  expect(rec.startChainCalls.length).toBe(1);
  const first = rec.startChainCalls[0];
  if (!first) throw new Error("expected startChain to be invoked");
  expect(first.message).toBe("SHORTENED.");
  expect(first.initial_agent).toBe("codex-acp-fast");
  expect((first as { task_class?: string }).task_class).toBe("STANDARD");
});

test("preflight zod validation fails BEFORE refiner is called", async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon("SHOULD NOT BE USED", rec);
  const handler = chainStartRefinedHandler(daemon);
  // Missing required initial_agent + task_class
  let caught: unknown;
  try {
    await handler({ message: "hi" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(rec.refineCalls).toEqual([]);
  expect(rec.startChainCalls).toEqual([]);
});

test("preflight catches invalid task_class without paying for refiner", async () => {
  const rec: CallRecord = { refineCalls: [], startChainCalls: [] };
  const daemon = makeDaemon("SHOULD NOT BE USED", rec);
  const handler = chainStartRefinedHandler(daemon);
  let caught: unknown;
  try {
    await handler({
      initial_agent: "codex-acp-fast",
      message: "hi",
      task_class: "INVALID",
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(rec.refineCalls).toEqual([]);
});

test("propagates refiner errors without calling startChain", async () => {
  const startChain = mock<StartChainFn>(() =>
    Promise.resolve({
      conversation_id: "c",
      handoff_id: "h",
    } as StartChainResult),
  );
  const dispatchRefine = mock<DispatchRefineFn>(() =>
    Promise.reject(new Error("refiner_unavailable")),
  );
  const daemon = fakeDaemon({ dispatchRefine, startChain });
  const handler = chainStartRefinedHandler(daemon);
  let caught: unknown;
  try {
    await handler({
      initial_agent: "codex-acp-fast",
      message: "real input",
      task_class: "STANDARD",
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("refiner_unavailable");
  expect(startChain).not.toHaveBeenCalled();
});
