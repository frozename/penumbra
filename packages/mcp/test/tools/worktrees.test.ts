import { expect, mock, test } from "bun:test";

import { type DaemonClient, DaemonHttpError } from "@src/daemon-client.js";
import { chainStartHandler } from "@src/tools/chain-start.js";
import { TOOL_REGISTRY } from "@src/tools/registry.js";
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
    Promise.resolve({
      worktree: {},
      diff_against_main: "",
      branch_log: "",
      base_ref: "origin/main",
      base_fallback: false,
      base_attempted_ref: "origin/main",
      base_fallback_reason: null,
    }),
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

test("worktree_inspect description names base_ref and every base fallback reason", () => {
  const description = TOOL_REGISTRY.worktree_inspect?.descriptor.description ?? "";
  for (const term of [
    "base_ref",
    "base_attempted_ref",
    "base_fallback_reason",
    "unresolvable",
    "rejected_ref",
    "chain_limit",
  ]) {
    expect({ term, present: description.includes(term) }).toEqual({ term, present: true });
  }
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

const DEADLINE_MESSAGE =
  "worktree inspection deadline expired during diff (git diff) after 5012 ms (budget 5000 ms)";
const PARTIAL = {
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  branch_name: "agent/h1",
  dirty: false,
  base_ref: "main",
  verified: false,
};

interface ParsedInspectError {
  error: { code: string; message: string; partial?: Record<string, unknown> };
}

async function inspectRejectedWith(
  status: number,
  body: unknown,
): Promise<{ isError: boolean | undefined; text: string }> {
  const { daemon, mocks } = makeMocks();
  mocks.inspectWorktree.mockRejectedValue(
    new DaemonHttpError(
      status === 404 ? "missing worktree" : "daemon /worktrees/h1: HTTP 500",
      status,
      body,
    ),
  );
  const res = await worktreeInspectHandler(daemon)({ handoff_id: "h1" });
  return { isError: res.isError, text: res.content[0]?.text ?? "" };
}

test("worktree.inspect passes the deadline partial through", async () => {
  const { isError, text } = await inspectRejectedWith(500, {
    error: { code: "inspection_failed", message: DEADLINE_MESSAGE, partial: PARTIAL },
  });
  expect(isError).toBe(true);
  expect(JSON.parse(text) as ParsedInspectError).toEqual({
    error: { code: "inspection_failed", message: DEADLINE_MESSAGE, partial: PARTIAL },
  });
});

test("worktree.inspect passes a partial without base_ref through without adding one", async () => {
  const partial = {
    head_sha: PARTIAL.head_sha,
    branch_name: "agent/h1",
    dirty: true,
    verified: false,
  };
  const { text } = await inspectRejectedWith(500, {
    error: { code: "inspection_failed", message: DEADLINE_MESSAGE, partial },
  });
  const parsed = JSON.parse(text) as ParsedInspectError;
  expect(parsed.error.partial).toEqual(partial);
  expect(Object.keys(parsed.error.partial ?? {}).sort()).toEqual([
    "branch_name",
    "dirty",
    "head_sha",
    "verified",
  ]);
});

test("worktree.inspect strips unknown keys from the partial", async () => {
  const { text } = await inspectRejectedWith(500, {
    error: {
      code: "inspection_failed",
      message: DEADLINE_MESSAGE,
      partial: { ...PARTIAL, diff_against_main: "unvalidated" },
    },
  });
  const parsed = JSON.parse(text) as ParsedInspectError;
  expect(Object.keys(parsed.error.partial ?? {}).sort()).toEqual([
    "base_ref",
    "branch_name",
    "dirty",
    "head_sha",
    "verified",
  ]);
  expect(parsed.error.partial).toEqual(PARTIAL);
});

test("worktree.inspect drops a malformed partial and keeps code and message", async () => {
  for (const partial of [
    { ...PARTIAL, verified: true },
    { ...PARTIAL, head_sha: 42 },
  ]) {
    const { isError, text } = await inspectRejectedWith(500, {
      error: { code: "inspection_failed", message: DEADLINE_MESSAGE, partial },
    });
    expect(isError).toBe(true);
    expect(text).toBe(
      JSON.stringify({ error: { code: "inspection_failed", message: DEADLINE_MESSAGE } }),
    );
  }
});

test("worktree.inspect ignores a partial on a 404", async () => {
  const { text } = await inspectRejectedWith(404, {
    error: { code: "not_found", message: "m", partial: PARTIAL },
  });
  expect(text).toBe(JSON.stringify({ error: { code: "not_found", message: "missing worktree" } }));
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
