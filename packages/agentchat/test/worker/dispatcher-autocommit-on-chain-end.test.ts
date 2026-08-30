import type { Logger } from "@penumbra/core";
import type { execFile as nodeExecFile } from "node:child_process";

import {
  autocommitOnChainEnd,
  filterAutocommitPaths,
  parseGitStatusPaths,
} from "@src/worker/autocommit-on-chain-end.js";
import { createWorkerDispatcher, type WorkerDispatcherDeps } from "@src/worker/dispatcher.js";
import { expect, mock, test } from "bun:test";

const handoff = {
  handoff_id: "h-auto",
  ts: "t",
  project_id: "proj-1",
  conversation_id: "conv-1",
  from_agent: "planner",
  to_agent: "executor",
  to_role: null,
  message: "m",
  status: "approved",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
};

// Bun's mock() returns Mock<(...args: unknown[]) => unknown>; the .mock.calls
// array is therefore unknown[][] and TypeScript loses the concrete arg tuple
// across the cast. Single helper laundering through `as unknown as` lets each
// caller declare the tuple it expects without re-asserting at every read site.
function mockCalls<T extends readonly unknown[] = unknown[]>(fn: unknown): T[] {
  return (fn as { mock: { calls: T[] } }).mock.calls;
}

// pino's Logger has heavily-overloaded info/warn/debug signatures the bun mock
// can't structurally satisfy. Single laundering helper produces a Logger-typed
// stub from a plain {info,warn,debug} shape so each test reads the original
// mock spies for assertions but the dispatcher sees a Logger.
function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

function makeLog(): Logger {
  return asLogger({ info: mock(), warn: mock(), debug: mock() });
}

function expectOnChainEndCall(
  onChainEnd: ReturnType<typeof mock>,
  expected: {
    handoff: typeof handoff;
    reason: "completed" | "cancelled";
    worktreeChanged: boolean;
    dirty: boolean;
    committed: boolean;
    minWallMs?: number;
  },
): void {
  expect(onChainEnd).toHaveBeenCalledTimes(1);
  const call = onChainEnd.mock.calls[0];
  if (!call) throw new Error("expected onChainEnd call");

  expect(call.slice(0, 5)).toEqual([
    expected.handoff,
    expected.reason,
    expected.worktreeChanged,
    expected.dirty,
    expected.committed,
  ]);
  expect(call).toHaveLength(8);
  expect(typeof call[5]).toBe("number");
  expect(call[5]).toBeGreaterThanOrEqual(expected.minWallMs ?? 0);
  expect(call[6]).toBeNull();
  expect(call[7]).toBe("result");
}

function asExecFile(fn: ReturnType<typeof mock>): typeof nodeExecFile {
  return fn as unknown as typeof nodeExecFile;
}

function callArg(fn: ReturnType<typeof mock>, callIndex: number, argIndex: number): unknown {
  const call = fn.mock.calls[callIndex];
  if (!call) throw new Error(`expected call ${String(callIndex)}`);
  return call[argIndex];
}

interface DispatchEventLike {
  kind?: string;
  handoff_id?: string;
  conversation_id?: string;
  project_id?: string;
  agent?: string;
  meta?: Record<string, unknown>;
}

function deps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: "dispatched" }),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention",
      text: "result",
      agent: "executor",
    }),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    markFailed: mock().mockResolvedValue(undefined),
    log: makeLog(),
    concurrency: 1,
    onDispatchEvent: mock(),
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: false,
      dirty: false,
      committed: false,
    }),
    autocommitOnChainEnd: mock().mockResolvedValue(undefined),
    ...over,
  };
}

test("no changes skips autocommit and still runs onChainEnd", async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const onDispatchEvent = mock();
  const d = deps({
    onChainEnd,
    onDispatchEvent,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: false,
      dirty: false,
      committed: false,
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expect(
    mockCalls<[DispatchEventLike]>(onDispatchEvent).some(
      (call) => call[0].kind === "autocommit_on_chain_end",
    ),
  ).toBe(false);
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "completed",
    worktreeChanged: false,
    dirty: false,
    committed: false,
  });
});

test("real commit skips autocommit and still runs onChainEnd", async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const d = deps({
    onChainEnd,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: false,
      committed: true,
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "completed",
    worktreeChanged: true,
    dirty: false,
    committed: true,
  });
});

test("dirty uncommitted completed dispatch autocommits before onChainEnd", async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock().mockResolvedValue(undefined);
  const onDispatchEvent = mock();
  const d = deps({
    onChainEnd,
    onDispatchEvent,
    autocommitOnChainEnd,
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: true,
      committed: false,
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).toHaveBeenCalledTimes(1);
  expect(autocommitOnChainEnd).toHaveBeenCalledWith(handoff);
  expect(onDispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "autocommit_on_chain_end",
      handoff_id: "h-auto",
      conversation_id: "conv-1",
      project_id: "proj-1",
      agent: "executor",
    }),
  );
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "completed",
    worktreeChanged: true,
    dirty: true,
    committed: false,
  });
});

test("dispatch.end meta reflects post-recovery snapshot after autocommit", async () => {
  const onChainEnd = mock();
  const onEvent = mock();
  const autocommitOnChainEnd = mock().mockResolvedValue(undefined);
  const snapshot = mock()
    .mockResolvedValueOnce({ worktreeChanged: true, dirty: true, committed: false })
    .mockResolvedValueOnce({ worktreeChanged: false, dirty: false, committed: true });
  const d = deps({
    onChainEnd,
    onEvent,
    autocommitOnChainEnd,
    getWorktreeSnapshot: snapshot,
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  const dispatchEnd = mockCalls<[DispatchEventLike]>(onEvent).find(
    (call) => call[0].kind === "dispatch.end",
  )?.[0];
  expect(dispatchEnd?.meta).toEqual(
    expect.objectContaining({
      status: "ok",
      dirty: false,
      committed: true,
      worktree_changed: false,
    }) as Record<string, unknown>,
  );
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "completed",
    worktreeChanged: true,
    dirty: true,
    committed: false,
  });
});

test("autocommit is suppressed on non-success reasons", async () => {
  const onChainEnd = mock();
  const autocommitOnChainEnd = mock();
  const d = deps({
    onChainEnd,
    autocommitOnChainEnd,
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "untrusted",
      text: "result",
      agent: "executor",
    }),
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: true,
      committed: false,
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(autocommitOnChainEnd).not.toHaveBeenCalled();
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "cancelled",
    worktreeChanged: true,
    dirty: true,
    committed: false,
  });
});

test("autocommit failures warn and still run onChainEnd", async () => {
  const onChainEnd = mock();
  const warn = mock();
  const d = deps({
    onChainEnd,
    log: asLogger({ info: mock(), warn, debug: mock() }),
    autocommitOnChainEnd: mock().mockRejectedValue(new Error("git commit failed")),
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: true,
      committed: false,
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      component: "autocommit-on-chain-end",
      handoff_id: "h-auto",
    }),
    "autocommit on chain end failed",
  );
  expectOnChainEndCall(onChainEnd, {
    handoff,
    reason: "completed",
    worktreeChanged: true,
    dirty: true,
    committed: false,
  });
});

test("parseGitStatusPaths and filterAutocommitPaths reject denied entries", () => {
  const paths = parseGitStatusPaths(
    " M packages/app/src/index.ts\n M .env\n?? docs/notes.md\n?? secret.pem\n",
  );
  expect(filterAutocommitPaths(paths)).toEqual(["packages/app/src/index.ts", "docs/notes.md"]);
});

test("filterAutocommitPaths rejects case-variant secret paths", () => {
  expect(filterAutocommitPaths([".ENV", "secret.PEM", "private.Key"])).toEqual([]);
});

test("filterAutocommitPaths rejects secret filename variants", () => {
  expect(
    filterAutocommitPaths([
      "id_rsa",
      "id_ed25519.pub",
      "secret.pem.bak",
      "private.key.old",
      "cert.crt.orig",
      "vault.p12.swp",
      ".env.local",
      "Secret.PEM.BAK",
      "README.md",
      "packages/app/src/foo.ts",
      "packages/app/tests/secret-handling.test.ts",
    ]),
  ).toEqual(["README.md", "packages/app/src/foo.ts", "packages/app/tests/secret-handling.test.ts"]);
});

test("filterAutocommitPaths keeps top-level source dirs under deny-by-default policy", () => {
  expect(filterAutocommitPaths(["packages/foo.ts", "scripts/bar.ts", "test/baz.test.ts"])).toEqual([
    "packages/foo.ts",
    "scripts/bar.ts",
    "test/baz.test.ts",
  ]);
});

test("filterAutocommitPaths drops build/dependency artifact dirs", () => {
  expect(
    filterAutocommitPaths([
      "node_modules/foo/index.js",
      "dist/bundle.js",
      "build/out.js",
      "local_cache/entry",
      "coverage/lcov.info",
      ".git/HEAD",
      "packages/app/node_modules/dep/index.js",
      "packages/app/dist/x.js",
    ]),
  ).toEqual([]);
});

test("autocommit warns with dropped_paths when some paths are filtered out", async () => {
  const warn = mock();
  const execFile = mock()
    .mockResolvedValueOnce({
      stdout: " M packages/app/src/index.ts\n M .env\n?? node_modules/foo/x.js\n",
    })
    .mockResolvedValueOnce({ stdout: "" })
    .mockResolvedValueOnce({ stdout: "" });
  const committed = await autocommitOnChainEnd(
    {
      handoff_id: "123e4567-e89b-12d3-a456-426614174777",
      conversation_id: "conv-1",
      to_agent: "executor",
    },
    { path: "/tmp/repo" },
    { execFile: asExecFile(execFile), log: { warn, debug: mock() } },
  );

  expect(committed).toBe(true);
  const droppedWarn = mockCalls<[Record<string, unknown>, string]>(warn).find(
    (call) => call[1] === "autocommit on chain end dropped paths",
  );
  expect(droppedWarn).toBeDefined();
  expect(droppedWarn?.[0]).toMatchObject({
    component: "autocommit-on-chain-end",
    handoff_id: "123e4567-e89b-12d3-a456-426614174777",
  });
  const droppedPaths = droppedWarn?.[0]?.dropped_paths;
  expect(Array.isArray(droppedPaths) && droppedPaths).toEqual([".env", "node_modules/foo/x.js"]);
});

test("autocommit skips malformed handoff ids", async () => {
  const warn = mock();
  const execFile = mock();
  const committed = await autocommitOnChainEnd(
    { handoff_id: "../../etc/passwd", conversation_id: "conv-1", to_agent: "executor" },
    { path: "/tmp/repo" },
    { execFile: asExecFile(execFile), log: { warn, debug: mock() } },
  );

  expect(committed).toBe(false);
  expect(execFile).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      component: "autocommit-on-chain-end",
      handoff_id: "../../etc/passwd",
      msg: "malformed handoff_id; skipping autocommit",
    }),
    "autocommit on chain end skipped",
  );
});

test("autocommit stages only allowed paths and skips empty filtered sets", async () => {
  const warn = mock();
  const execFile = mock()
    .mockResolvedValueOnce({ stdout: " M packages/app/src/index.ts\n M .env\n?? docs/notes.md\n" })
    .mockResolvedValueOnce({ stdout: "" })
    .mockResolvedValueOnce({ stdout: "" });
  const committed = await autocommitOnChainEnd(
    {
      handoff_id: "123e4567-e89b-12d3-a456-426614174000",
      conversation_id: "conv-1",
      to_agent: "executor",
    },
    { path: "/tmp/repo" },
    { execFile: asExecFile(execFile), log: { warn, debug: mock() } },
  );

  expect(committed).toBe(true);
  expect(callArg(execFile, 0, 1)).toEqual([
    "-C",
    "/tmp/repo",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  expect(callArg(execFile, 1, 1)).toEqual([
    "-C",
    "/tmp/repo",
    "add",
    "--",
    "packages/app/src/index.ts",
  ]);
  expect(callArg(execFile, 2, 1)).toEqual(["-C", "/tmp/repo", "add", "--", "docs/notes.md"]);
  expect((callArg(execFile, 3, 1) as string[])[2]).toBe("commit");
  expect(
    mockCalls<[string, string[]]>(execFile).some((call) => String(call[1]).includes(".env")),
  ).toBe(false);

  const emptyExecFile = mock().mockResolvedValueOnce({ stdout: " M .env\n" });
  const skipped = await autocommitOnChainEnd(
    {
      handoff_id: "123e4567-e89b-12d3-a456-426614174001",
      conversation_id: "conv-1",
      to_agent: "executor",
    },
    { path: "/tmp/repo" },
    { execFile: asExecFile(emptyExecFile), log: { warn, debug: mock() } },
  );

  expect(skipped).toBe(false);
  expect(mockCalls<[string, string[]]>(emptyExecFile).some((call) => call[1][2] === "commit")).toBe(
    false,
  );
  expect(
    mockCalls<[unknown, string]>(warn).some(
      (call) => call[1] === "autocommit on chain end skipped",
    ),
  ).toBe(true);
});
