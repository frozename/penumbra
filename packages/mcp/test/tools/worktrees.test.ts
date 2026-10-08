import { expect, mock, test } from "bun:test";

import { type DaemonClient, DaemonHttpError } from "@src/daemon-client.js";
import { chainStartHandler } from "@src/tools/chain-start.js";
import { worktreeCleanupHandler } from "@src/tools/worktree-cleanup.js";
import { worktreeInspectHandler } from "@src/tools/worktree-inspect.js";
import { worktreeListHandler } from "@src/tools/worktree-list.js";

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

test("worktree.inspect surfaces the daemon inspection error code and message", async () => {
  const { daemon, mocks } = makeMocks();
  mocks.inspectWorktree.mockRejectedValue(
    new DaemonHttpError("daemon /worktrees/h1: HTTP 500", 500, {
      error: { code: "inspection_failed", message: "x" },
    }),
  );
  const result = await worktreeInspectHandler(daemon)({ handoff_id: "h1" }).catch(
    (err: unknown) => err,
  );
  expect(result).toEqual({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: "inspection_failed", message: "x" } }),
      },
    ],
  });
});

test("worktree.inspect preserves not_found for 404 errors", async () => {
  const { daemon, mocks } = makeMocks();
  mocks.inspectWorktree.mockRejectedValue(new DaemonHttpError("missing worktree", 404));
  const res = await worktreeInspectHandler(daemon)({ handoff_id: "h1" });
  expect(res.isError).toBe(true);
  expect(JSON.parse(res.content[0]?.text ?? "null")).toEqual({
    error: { code: "not_found", message: "missing worktree" },
  });
});

test("worktree.inspect provides structured fallback for an unstructured HTTP error", async () => {
  const { daemon, mocks } = makeMocks();
  mocks.inspectWorktree.mockRejectedValue(new DaemonHttpError("HTTP 503", 503, "unavailable"));
  const result = await worktreeInspectHandler(daemon)({ handoff_id: "h1" }).catch(
    (err: unknown) => err,
  );
  expect(result).toEqual({
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: { code: "unknown", message: "HTTP 503" } }) },
    ],
  });
});

test("worktree.inspect rethrows non-HTTP errors", async () => {
  const { daemon, mocks } = makeMocks();
  const error = new Error("transport failed");
  mocks.inspectWorktree.mockRejectedValue(error);
  const result = await worktreeInspectHandler(daemon)({ handoff_id: "h1" }).catch(
    (err: unknown) => err,
  );
  expect(result).toBe(error);
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
