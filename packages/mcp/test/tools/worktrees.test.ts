import { expect, test, spyOn, mock, beforeEach } from "bun:test";
import { worktreeListHandler } from "../../src/tools/worktree-list.js";
import { worktreeInspectHandler } from "../../src/tools/worktree-inspect.js";
import { worktreeCleanupHandler } from "../../src/tools/worktree-cleanup.js";
import { chainStartHandler } from "../../src/tools/chain-start.js";

const mockDaemon: any = {
  listWorktrees: mock(async () => ({ worktrees: [] })),
  inspectWorktree: mock(async () => ({ worktree: {}, diff_against_main: "", branch_log: "" })),
  cleanupWorktree: mock(async () => ({ status: "torn_down" })),
  startChain: mock(async () => ({ conversation_id: "c1", handoff_id: "h1" })),
};

test("worktree.list tool calls daemon", async () => {
  const handler = worktreeListHandler(mockDaemon);
  const res = await (handler as any)();
  expect(mockDaemon.listWorktrees).toHaveBeenCalled();
  expect(res.content[0].text).toBe(JSON.stringify({ worktrees: [] }));
});

test("worktree.inspect tool calls daemon", async () => {
  const handler = worktreeInspectHandler(mockDaemon);
  await (handler as any)({ handoff_id: "h1" });
  expect(mockDaemon.inspectWorktree).toHaveBeenCalledWith("h1");
});

test("worktree.cleanup tool calls daemon", async () => {
  const handler = worktreeCleanupHandler(mockDaemon);
  await (handler as any)({ handoff_id: "h1", force: true });
  expect(mockDaemon.cleanupWorktree).toHaveBeenCalledWith("h1", true);
});

test("chain.start tool passes use_worktree", async () => {
  const handler = chainStartHandler(mockDaemon);
  await (handler as any)({ initial_agent: "a", message: "m", use_worktree: false });
  expect(mockDaemon.startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      use_worktree: false,
    }),
  );
});

test("chain.start tool passes open_pr_on_review", async () => {
  const handler = chainStartHandler(mockDaemon);
  await (handler as any)({ initial_agent: "a", message: "m", open_pr_on_review: true });
  expect(mockDaemon.startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      open_pr_on_review: true,
    }),
  );
});
