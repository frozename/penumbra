import { type HandoffRow, type Logger, WorktreeManager } from "@penumbra/core";
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  createMergeReconciler,
  type MergeResult,
  type ReconcilerDeps,
  type ReconcilerVerdict,
} from "../../src/worker/merge-reconciler.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

class ExecCommandError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly code: number | undefined;

  constructor(init: { stdout?: string; stderr?: string; code?: number } = {}) {
    super(init.stderr ?? init.stdout ?? "");
    this.name = "ExecCommandError";
    this.stdout = init.stdout ?? "";
    this.stderr = init.stderr ?? "";
    this.code = init.code;
  }
}

const branchHeadSha = "b".repeat(40);
const baseTipSha = "a".repeat(40);
let mergeBaseSha = "c".repeat(40);
const execHistory: { cmd: string; cwd: string }[] = [];
const verdicts: ReconcilerVerdict[] = [];
let diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
let branchTestOutcome: "pass" | "pre-existing-fail" | "new-fail" | "panic-pass" | "crash" = "pass";
let baseHasPreExistingFailure = false;
let holdBranchTestOpen = false;
let branchTestOutputOverride: string | null = null;
let baseTestOutputOverride: string | null = null;

const brokenBaselineRaw = readFileSync(
  new URL("../fixtures/merge-reconciler/broken-baseline-raw.txt", import.meta.url),
  "utf8",
);
const healthyBranchRaw = readFileSync(
  new URL("../fixtures/merge-reconciler/healthy-branch-raw.txt", import.meta.url),
  "utf8",
);

function makeHandoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: "h-tests",
    ts: "2026-08-17T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-tests",
    from_agent: "user",
    to_agent: "codex",
    to_role: null,
    message: "tests-stage regression",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    open_pr_on_review: false,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    dispatch_attempts: 0,
    max_dispatch_attempts: 3,
    ...overrides,
  } as unknown as HandoffRow;
}

function makeTestLogger(): Logger {
  return {
    info: mock((..._args: unknown[]) => undefined),
    warn: mock((..._args: unknown[]) => undefined),
    debug: mock((..._args: unknown[]) => undefined),
    error: mock((..._args: unknown[]) => undefined),
  } as unknown as Logger;
}

function passOutput(count = 9): string {
  return `(pass) in-process permissions > approves queued writes [1.00ms]

 ${String(count)} pass
 0 fail
 0 error
Ran ${String(count)} tests across 1 files. [12.00ms]
`;
}

function failOutput(name: string, count = 9): string {
  return `(fail) ${name} [2.00ms]
error: expect(received).toBe(expected)

 ${String(count - 1)} pass
 1 fail
 0 error
Ran ${String(count)} tests across 1 files. [12.00ms]
`;
}

function daemonUnenumerableFailureOutput(init: {
  reportedFails: number;
  reportedErrors: number;
  enumerableFails: number;
  perTestMs: string;
  totalTime: string;
}): string {
  const failures = Array.from(
    { length: init.enumerableFails },
    (_, index) =>
      `(fail) daemon existing suite > failure ${String(index + 1)} [${init.perTestMs}]\n`,
  ).join("");
  return `bun test v1.3.14 (0d9b296a)

packages/daemon/test/dreaming/cycle.test.ts:
${failures}
packages/daemon/test/sweepers/reconciler-sweep.test.ts:

# Unhandled error between tests
-------------------------------
62 |         await closePullRequest({ number: 10, comment: "", deleteBranch: true });
                   ^
error: "await" can only be used inside an "async" function
    at /worktree/branch/packages/daemon/test/sweepers/reconciler-sweep.test.ts:62:15
-------------------------------

packages/daemon/test/sweepers/notification-sweeper.test.ts:
(pass) notification-sweeper: discovery > discovers task_draft events [${init.perTestMs}]

 ${String(1944 - init.reportedFails)} pass
 ${String(init.reportedFails)} fail
 ${String(init.reportedErrors)} error
Ran 1944 tests across 204 files. [${init.totalTime}]
`;
}

function panicOutput(): string {
  return `${passOutput()}
panic(main thread): A C++ exception occurred
Bun has crashed
`;
}

function isBaselineCwd(cwd: string): boolean {
  return cwd.includes("test-baseline");
}

function execMock(argv: string[], opts: { cwd: string }): Promise<ExecResult> {
  const cmd = argv.join(" ");
  execHistory.push({ cmd, cwd: opts.cwd });

  if (cmd === "git rev-parse HEAD") {
    return Promise.resolve({ stdout: `${branchHeadSha}\n`, stderr: "" });
  }
  if (cmd === "git rev-parse main") {
    return Promise.resolve({ stdout: `${baseTipSha}\n`, stderr: "" });
  }
  if (cmd === `git merge-base ${baseTipSha} ${branchHeadSha}`) {
    return Promise.resolve({ stdout: `${mergeBaseSha}\n`, stderr: "" });
  }
  if (cmd.startsWith("git diff --name-only")) {
    return Promise.resolve({ stdout: diffOutput, stderr: "" });
  }
  if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
    return Promise.resolve({ stdout: " 1 file changed, 1 insertion(+)\n", stderr: "" });
  }
  if (cmd.startsWith("git merge-base --is-ancestor")) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd.startsWith("git worktree ") || cmd.startsWith("git checkout ")) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd.startsWith("bun tsc -b")) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd === "bun test packages/daemon/test/") {
    if (holdBranchTestOpen && !isBaselineCwd(opts.cwd)) {
      return new Promise<ExecResult>(() => undefined);
    }
    if (isBaselineCwd(opts.cwd)) {
      if (baseTestOutputOverride !== null) {
        return Promise.reject(new ExecCommandError({ stdout: baseTestOutputOverride, code: 1 }));
      }
      if (baseHasPreExistingFailure) {
        return Promise.reject(
          new ExecCommandError({
            stdout: failOutput("daemon existing suite > already fails"),
            code: 1,
          }),
        );
      }
      return Promise.resolve({ stdout: passOutput(), stderr: "" });
    }
    if (branchTestOutputOverride !== null) {
      return Promise.reject(new ExecCommandError({ stdout: branchTestOutputOverride, code: 1 }));
    }
    if (branchTestOutcome === "pre-existing-fail") {
      return Promise.reject(
        new ExecCommandError({
          stdout: failOutput("daemon existing suite > already fails"),
          code: 1,
        }),
      );
    }
    if (branchTestOutcome === "new-fail") {
      return Promise.reject(
        new ExecCommandError({
          stdout: failOutput("daemon changed suite > newly fails", 10),
          code: 1,
        }),
      );
    }
    if (branchTestOutcome === "panic-pass") {
      return Promise.reject(new ExecCommandError({ stdout: panicOutput(), code: 133 }));
    }
    if (branchTestOutcome === "crash") {
      return Promise.reject(
        new ExecCommandError({
          stderr: "panic(main thread): A C++ exception occurred\nBun has crashed\n",
          code: 133,
        }),
      );
    }
    return Promise.resolve({ stdout: passOutput(), stderr: "" });
  }

  return Promise.resolve({ stdout: "", stderr: "" });
}

const emitVerdict = mock((verdict: ReconcilerVerdict) => {
  verdicts.push(verdict);
  return Promise.resolve();
});
const notifyResult = mock((_handoffId: string, _result: MergeResult) => Promise.resolve());
const postProgress = mock((_handoffId: string, _payload: unknown) => Promise.resolve());
const baselineNodeModulesMirror = mock(() => undefined);

const deps: ReconcilerDeps = {
  worktreeManager: new WorktreeManager(),
  postProgress,
  notifyResult,
  emitVerdict,
  log: makeTestLogger(),
  mainRepoDir: "/main/repo",
  rebaseScratchRoot: "/tmp/reconciler-test-scratch",
  getHandoff: mock(() => Promise.resolve(makeHandoffRow())),
  exec: execMock,
  mirrorNodeModuleSymlinks: baselineNodeModulesMirror,
  settings: {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  },
};

const getWorktreeSpy = spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation(
  (handoffId: string) => ({
    handoffId,
    path: `/worktree/${handoffId}`,
    branchName: `agent/${handoffId}`,
    storageRoot: `/worktree/${handoffId}/.test-storage`,
    createdAt: "",
    status: "created" as const,
    worktreeMode: "symlink_mirror" as const,
  }),
);

afterAll(() => {
  getWorktreeSpy.mockRestore();
});

beforeEach(() => {
  execHistory.length = 0;
  verdicts.length = 0;
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  mergeBaseSha = "c".repeat(40);
  branchTestOutcome = "pass";
  baseHasPreExistingFailure = false;
  holdBranchTestOpen = false;
  branchTestOutputOverride = null;
  baseTestOutputOverride = null;
  baselineNodeModulesMirror.mockClear();
  deps.mirrorNodeModuleSymlinks = baselineNodeModulesMirror;
  deps.settings = {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  };
  emitVerdict.mockClear();
  notifyResult.mockClear();
  postProgress.mockClear();
});

function makeReconciler(): ReturnType<typeof createMergeReconciler> {
  return createMergeReconciler(deps);
}

test("pre-existing scoped test failure present at base and branch does not fail the branch", async () => {
  baseHasPreExistingFailure = true;
  branchTestOutcome = "pre-existing-fail";

  const result = await makeReconciler()("h-pre-existing");

  expect(result.status).toBe("verified");
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-pre-existing",
    tests: "pass",
  });
});

test("a captured zero-pass load-error baseline is a test environment error", async () => {
  mergeBaseSha = "f".repeat(40);
  baseTestOutputOverride = brokenBaselineRaw;
  branchTestOutputOverride = healthyBranchRaw;

  const result = await makeReconciler()("h-captured-broken-baseline");

  expect(result.status).toBe("test_failed");
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-captured-broken-baseline",
    tests: "error",
  });
});

test("captured branch failures shared by a healthy baseline are suppressed", async () => {
  mergeBaseSha = "g".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;

  const result = await makeReconciler()("h-captured-shared-failures");

  expect(result.status).toBe("verified");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-captured-shared-failures",
    tests: "pass",
  });
});

test("baseline setup mirrors node_modules into its scratch worktree", async () => {
  mergeBaseSha = "h".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;
  const mirrorNodeModuleSymlinks = mock(() => undefined);
  deps.mirrorNodeModuleSymlinks = mirrorNodeModuleSymlinks;

  await makeReconciler()("h-baseline-mirror");

  expect(mirrorNodeModuleSymlinks).toHaveBeenCalledWith(
    "/main/repo",
    "/tmp/reconciler-test-scratch/test-baseline/h-baseline-mirror",
    deps.log,
  );
});

test("pre-existing unenumerable scoped failures are stable across timing-only reruns", async () => {
  mergeBaseSha = "d".repeat(40);
  baseTestOutputOverride = daemonUnenumerableFailureOutput({
    reportedFails: 71,
    reportedErrors: 1,
    enumerableFails: 70,
    perTestMs: "17.63ms",
    totalTime: "52.34s",
  });
  branchTestOutputOverride = daemonUnenumerableFailureOutput({
    reportedFails: 71,
    reportedErrors: 1,
    enumerableFails: 70,
    perTestMs: "20.04ms",
    totalTime: "53.04s",
  });

  const result = await makeReconciler()("h-unenumerable-stable");

  expect(result.status).toBe("verified");
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-unenumerable-stable",
    tests: "pass",
  });
});

test("new unenumerable scoped failure count still fails the branch", async () => {
  mergeBaseSha = "e".repeat(40);
  baseTestOutputOverride = daemonUnenumerableFailureOutput({
    reportedFails: 71,
    reportedErrors: 1,
    enumerableFails: 70,
    perTestMs: "17.63ms",
    totalTime: "52.34s",
  });
  branchTestOutputOverride = daemonUnenumerableFailureOutput({
    reportedFails: 72,
    reportedErrors: 1,
    enumerableFails: 70,
    perTestMs: "17.63ms",
    totalTime: "52.34s",
  });

  const result = await makeReconciler()("h-unenumerable-regression");

  expect(result.status).toBe("test_failed");
  expect(result.regression_summary).toContain("new test failures");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-unenumerable-regression",
    tests: "fail",
  });
});

test("scoped test failure introduced only by the branch fails the branch", async () => {
  branchTestOutcome = "new-fail";

  const result = await makeReconciler()("h-new-fail");

  expect(result.status).toBe("test_failed");
  expect(result.regression_summary).toContain("daemon changed suite > newly fails");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-new-fail",
    tests: "fail",
  });
});

test("post-summary Bun teardown panic with zero reported failures does not fail the branch", async () => {
  branchTestOutcome = "panic-pass";

  const result = await makeReconciler()("h-panic-pass");

  expect(result.status).toBe("verified");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-panic-pass",
    tests: "pass",
  });
});

test("Bun crash before the reported summary still fails the branch", async () => {
  branchTestOutcome = "crash";

  const result = await makeReconciler()("h-crash");

  expect(result.status).toBe("test_failed");
  expect(result.regression_summary).toContain("Bun has crashed");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-crash",
    tests: "fail",
  });
});

test("docs-only diffs still skip the tests stage", async () => {
  diffOutput = "docs/concepts.md\n";

  const result = await makeReconciler()("h-docs");

  expect(result.status).toBe("verified");
  expect(execHistory.some(({ cmd }) => cmd.startsWith("bun test"))).toBe(false);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-docs",
    tests: "skipped",
  });
});

test("scoped test timeout still fails the tests stage", async () => {
  deps.settings = {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 0.001,
  };
  holdBranchTestOpen = true;

  const result = await makeReconciler()("h-timeout");

  expect(result).toMatchObject({
    status: "test_failed",
    timed_out: true,
  });
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-timeout",
    tests: "fail",
  });
});
