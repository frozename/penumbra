import { expect, test, mock } from "bun:test";
import { createWorkerDispatcher, type WorkerDispatcherDeps } from "../../src/worker/dispatcher.js";
import {
  autocommitOnChainEnd,
  filterAutocommitPaths,
  parseGitStatusPaths,
} from "../../src/worker/autocommit-on-chain-end.js";

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
) {
  expect(onChainEnd).toHaveBeenCalledTimes(1);
  const call = onChainEnd.mock.calls[0];

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
    log: { info: mock(), warn: mock(), debug: mock() } as any,
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
    onDispatchEvent.mock.calls.some((call) => call[0]?.kind === "autocommit_on_chain_end"),
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

  const dispatchEnd = onEvent.mock.calls.find((call) => call[0]?.kind === "dispatch.end")?.[0];
  expect(dispatchEnd?.meta).toEqual(
    expect.objectContaining({
      status: "ok",
      dirty: false,
      committed: true,
      worktree_changed: false,
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
    log: { info: mock(), warn, debug: mock() } as any,
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

test("parseGitStatusPaths and filterAutocommitPaths reject denied entries", async () => {
  const paths = parseGitStatusPaths(
    " M packages/app/src/index.ts\n M .env\n?? docs/notes.md\n?? secret.pem\n",
  );
  expect(filterAutocommitPaths(paths)).toEqual(["packages/app/src/index.ts", "docs/notes.md"]);
});

test("filterAutocommitPaths rejects case-variant secret paths", async () => {
  expect(filterAutocommitPaths([".ENV", "secret.PEM", "private.Key"])).toEqual([]);
});

test("filterAutocommitPaths rejects secret filename variants", async () => {
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

test("autocommit skips malformed handoff ids", async () => {
  const warn = mock();
  const execFile = mock();
  const committed = await autocommitOnChainEnd(
    { handoff_id: "../../etc/passwd", conversation_id: "conv-1", to_agent: "executor" },
    { path: "/tmp/repo" },
    { execFile, log: { warn, debug: mock() } as any },
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
    { execFile, log: { warn, debug: mock() } as any },
  );

  expect(committed).toBe(true);
  expect(execFile.mock.calls[0]![1]).toEqual([
    "-C",
    "/tmp/repo",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  expect(execFile.mock.calls[1]![1]).toEqual([
    "-C",
    "/tmp/repo",
    "add",
    "--",
    "packages/app/src/index.ts",
  ]);
  expect(execFile.mock.calls[2]![1]).toEqual(["-C", "/tmp/repo", "add", "--", "docs/notes.md"]);
  expect(execFile.mock.calls[3]![1][2]).toBe("commit");
  expect(execFile.mock.calls.some((call) => String(call[1]).includes(".env"))).toBe(false);

  const emptyExecFile = mock().mockResolvedValueOnce({ stdout: " M .env\n" });
  const skipped = await autocommitOnChainEnd(
    {
      handoff_id: "123e4567-e89b-12d3-a456-426614174001",
      conversation_id: "conv-1",
      to_agent: "executor",
    },
    { path: "/tmp/repo" },
    { execFile: emptyExecFile, log: { warn, debug: mock() } as any },
  );

  expect(skipped).toBe(false);
  expect(emptyExecFile.mock.calls.some((call) => call[1]?.[2] === "commit")).toBe(false);
  expect(warn.mock.calls.some((call) => call[1] === "autocommit on chain end skipped")).toBe(true);
});
