import type { DaemonClient } from "@src/daemon-client.js";

import { chainStartHandler } from "@src/tools/chain-start.js";
import { worktreeCleanupHandler } from "@src/tools/worktree-cleanup.js";
import { worktreeInspectHandler } from "@src/tools/worktree-inspect.js";
import { worktreeListHandler } from "@src/tools/worktree-list.js";
import { expect, mock, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type ListWorktreesFn = DaemonClient["listWorktrees"];
type InspectWorktreeFn = DaemonClient["inspectWorktree"];
type CleanupWorktreeFn = DaemonClient["cleanupWorktree"];
type StartChainFn = DaemonClient["startChain"];
type StartChainBody = Parameters<StartChainFn>[0];

interface Mocks {
  listWorktrees: ReturnType<typeof mock<ListWorktreesFn>>;
  inspectWorktree: ReturnType<typeof mock<InspectWorktreeFn>>;
  cleanupWorktree: ReturnType<typeof mock<CleanupWorktreeFn>>;
  startChain: ReturnType<typeof mock<StartChainFn>>;
}

function makeMocks(): { daemon: DaemonClient; mocks: Mocks } {
  const listWorktrees = mock<ListWorktreesFn>(() => Promise.resolve({ worktrees: [] }));
  const inspectWorktree = mock<InspectWorktreeFn>(() =>
    Promise.resolve({ worktree: {}, diff_against_main: "", branch_log: "" }),
  );
  const cleanupWorktree = mock<CleanupWorktreeFn>(() => Promise.resolve({ status: "torn_down" }));
  const startChain = mock<StartChainFn>(() =>
    Promise.resolve({ conversation_id: "c1", handoff_id: "h1" }),
  );
  const daemon = fakeDaemon({ listWorktrees, inspectWorktree, cleanupWorktree, startChain });
  return {
    daemon,
    mocks: { listWorktrees, inspectWorktree, cleanupWorktree, startChain },
  };
}

test("worktree.list tool calls daemon", async () => {
  const { daemon, mocks } = makeMocks();
  const handler = worktreeListHandler(daemon);
  const res = await handler();
  expect(mocks.listWorktrees).toHaveBeenCalled();
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toBe(JSON.stringify({ worktrees: [] }));
});

test("worktree.inspect tool calls daemon", async () => {
  const { daemon, mocks } = makeMocks();
  const handler = worktreeInspectHandler(daemon);
  await handler({ handoff_id: "h1" });
  expect(mocks.inspectWorktree).toHaveBeenCalledWith("h1");
});

test("worktree.cleanup tool calls daemon", async () => {
  const { daemon, mocks } = makeMocks();
  const handler = worktreeCleanupHandler(daemon);
  await handler({ handoff_id: "h1", force: true });
  expect(mocks.cleanupWorktree).toHaveBeenCalledWith("h1", true);
});

test("chain.start tool passes use_worktree", async () => {
  const { daemon, mocks } = makeMocks();
  const handler = chainStartHandler(daemon);
  await handler({
    initial_agent: "a",
    message: "m",
    use_worktree: false,
    task_class: "STANDARD",
  });
  expect(mocks.startChain).toHaveBeenCalledWith(
    expect.objectContaining<Partial<StartChainBody>>({
      use_worktree: false,
    }),
  );
});

test("chain.start tool passes open_pr_on_review", async () => {
  const { daemon, mocks } = makeMocks();
  const handler = chainStartHandler(daemon);
  await handler({
    initial_agent: "a",
    message: "m",
    open_pr_on_review: true,
    task_class: "STANDARD",
  });
  expect(mocks.startChain).toHaveBeenCalledWith(
    expect.objectContaining<Partial<StartChainBody>>({
      open_pr_on_review: true,
    }),
  );
});
