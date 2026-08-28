import * as core from "@penumbra/core";
import { type HandoffRow, type Logger, WorktreeManager } from "@penumbra/core";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createMergeReconciler,
  type MergeResult,
  type ReconcilerDeps,
  type ReconcilerVerdict,
} from "../../src/worker/merge-reconciler.js";
import { parseBunTestReport } from "../../src/worker/bun-test-output.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

class ExecCommandError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly code: number | string | undefined;

  constructor(init: { stdout?: string; stderr?: string; code?: number | string } = {}) {
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
let tempRoot = "";
let mainRepoDir = "";
let branchWorktreeRoot = "";
let scratchRoot = "";
let failBaselineInstall = false;
let timeoutBaselineInstall = false;
let contaminateBaselineConfigLink = false;
let materializeBranchLocalCache = false;
let observedBaselineNodeModulesIsSymlink: boolean | null = null;
let observedBaselineCoreIsSymlink: boolean | null = null;
let observedBaselineCoreRealpath: string | null = null;
let observedBaselineRootRealpath: string | null = null;
let observedBaselineLocalCacheRealpath: string | null = null;
let observedBaselineInstallOptions: ExecOptions | null = null;
let omitBaselineCoreLinkDuringInstall = false;

const brokenBaselineRaw = readFileSync(
  new URL("../fixtures/merge-reconciler/broken-baseline-raw.txt", import.meta.url),
  "utf8",
);
const healthyBranchRaw = readFileSync(
  new URL("../fixtures/merge-reconciler/healthy-branch-raw.txt", import.meta.url),
  "utf8",
);

test("parses zero passes from the captured broken baseline summary", () => {
  const report = parseBunTestReport(brokenBaselineRaw);

  expect(report.pass).toBe(0);
  expect(report.reachedSummary).toBe(true);
});

test("parses passes from the captured healthy branch summary", () => {
  const report = parseBunTestReport(healthyBranchRaw);

  expect(report.pass).toBe(1212);
  expect(report.reachedSummary).toBe(true);
});

test("reports an unknown pass count when the output has no pass line", () => {
  const report = parseBunTestReport("Ran 0 tests across 0 files. [1.00ms]\n");

  expect(report.pass).toBeNull();
});

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

function unhandledErrorOutput(suitePath: string, totalTime: string): string {
  return `bun test v1.3.14 (0d9b296a)

${suitePath}:

# Unhandled error between tests
-------------------------------
62 |         await closePullRequest({ number: 10, comment: "", deleteBranch: true });
                   ^
error: "await" can only be used inside an "async" function
    at /worktree/branch/${suitePath}:62:15
-------------------------------

 0 pass
 0 fail
 1 error
Ran 0 tests across 1 files. [${totalTime}]
`;
}

function summaryOnlyUnhandledErrorOutput(suitePath: string): string {
  return `bun test v1.3.14 (0d9b296a)

${suitePath}:

# Unhandled error between tests
-------------------------------
error: fixture load failed
    at /worktree/branch/${suitePath}:62:15
-------------------------------

 0 fail
 1 error
Ran 0 tests across 1 files. [1.00ms]
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

function ensureRepoFixture(root: string): void {
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  mkdirSync(join(root, "packages", "config"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
  );
  writeFileSync(
    join(root, "packages", "core", "package.json"),
    JSON.stringify({ name: "@penumbra/core", version: "0.0.0" }),
  );
  writeFileSync(
    join(root, "packages", "config", "package.json"),
    JSON.stringify({ name: "@penumbra/config", version: "0.0.0" }),
  );
  writeFileSync(join(root, "bun.lock"), "");
}

function materializeNodeModules(
  root: string,
  opts: { contaminateConfig?: boolean; omitCore?: boolean } = {},
): void {
  mkdirSync(join(root, "node_modules", "@penumbra"), { recursive: true });
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  mkdirSync(join(root, "packages", "config"), { recursive: true });
  const coreLink = join(root, "node_modules", "@penumbra", "core");
  rmSync(coreLink, { recursive: true, force: true });
  if (!opts.omitCore) {
    symlinkSync(join(root, "packages", "core"), coreLink, "dir");
  }
  const configLink = join(root, "node_modules", "@penumbra", "config");
  rmSync(configLink, { recursive: true, force: true });
  if (opts.contaminateConfig) {
    mkdirSync(configLink, { recursive: true });
    writeFileSync(join(configLink, "sentinel.txt"), "operator-owned config\n");
  } else {
    symlinkSync(join(root, "packages", "config"), configLink, "dir");
  }
}

function materializeMainNodeModules(): void {
  mkdirSync(join(mainRepoDir, "node_modules", "@penumbra"), { recursive: true });
  mkdirSync(join(mainRepoDir, "packages", "core"), { recursive: true });
  mkdirSync(join(mainRepoDir, "packages", "config"), { recursive: true });
  symlinkSync(
    join(mainRepoDir, "packages", "core"),
    join(mainRepoDir, "node_modules", "@penumbra", "core"),
    "dir",
  );
  symlinkSync(
    join(mainRepoDir, "packages", "config"),
    join(mainRepoDir, "node_modules", "@penumbra", "config"),
    "dir",
  );
}

function scratchPathFor(handoffId: string): string {
  return join(scratchRoot, "test-baseline", handoffId);
}

function execMock(argv: string[], opts: ExecOptions): Promise<ExecResult> {
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
  if (cmd === `git show ${mergeBaseSha}:bun.lock`) {
    return Promise.resolve({
      stdout: readFileSync(join(mainRepoDir, "bun.lock"), "utf8"),
      stderr: "",
    });
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
  if (cmd.startsWith("git worktree remove --force ")) {
    rmSync(argv.at(-1) ?? "", { recursive: true, force: true });
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd.startsWith("git worktree add --detach ")) {
    const worktreePath = argv[4];
    if (worktreePath !== undefined) {
      ensureRepoFixture(worktreePath);
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd.startsWith("git worktree ") || cmd.startsWith("git checkout ")) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (cmd === "bun install --ignore-scripts --frozen-lockfile") {
    if (isBaselineCwd(opts.cwd)) observedBaselineInstallOptions = opts;
    if (failBaselineInstall && isBaselineCwd(opts.cwd)) {
      return Promise.reject(new ExecCommandError({ stderr: "lockfile had changes", code: 1 }));
    }
    if (timeoutBaselineInstall && isBaselineCwd(opts.cwd)) {
      return Promise.reject(
        new ExecCommandError({ stderr: "operation timed out", code: "ETIMEDOUT" }),
      );
    }
    materializeNodeModules(opts.cwd, {
      contaminateConfig: contaminateBaselineConfigLink && isBaselineCwd(opts.cwd),
      omitCore: omitBaselineCoreLinkDuringInstall && isBaselineCwd(opts.cwd),
    });
    if (materializeBranchLocalCache && existsSync(join(mainRepoDir, "local_cache"))) {
      mkdirSync(dirname(join(opts.cwd, "local_cache")), { recursive: true });
      symlinkSync(join(mainRepoDir, "local_cache"), join(opts.cwd, "local_cache"), "dir");
    }
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
      const baselineNodeModules = join(opts.cwd, "node_modules");
      if (existsSync(baselineNodeModules)) {
        observedBaselineNodeModulesIsSymlink = lstatSync(baselineNodeModules).isSymbolicLink();
      }
      const baselineCore = join(baselineNodeModules, "@penumbra", "core");
      if (existsSync(baselineCore)) {
        observedBaselineCoreIsSymlink = lstatSync(baselineCore).isSymbolicLink();
        observedBaselineCoreRealpath = realpathSync(baselineCore);
      }
      observedBaselineRootRealpath = realpathSync(opts.cwd);
      const baselineLocalCache = join(opts.cwd, "local_cache");
      if (existsSync(baselineLocalCache)) {
        observedBaselineLocalCacheRealpath = realpathSync(baselineLocalCache);
      }
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

const deps: ReconcilerDeps = {
  worktreeManager: new WorktreeManager(),
  postProgress,
  notifyResult,
  emitVerdict,
  log: makeTestLogger(),
  mainRepoDir: "/unused/main/repo",
  rebaseScratchRoot: "/unused/reconciler-test-scratch",
  getHandoff: mock(() => Promise.resolve(makeHandoffRow())),
  exec: execMock,
  settings: {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  },
};

const getWorktreeSpy = spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation(
  (handoffId: string) => ({
    handoffId,
    path: branchWorktreeRoot,
    branchName: `agent/${handoffId}`,
    storageRoot: join(branchWorktreeRoot, ".test-storage"),
    createdAt: "",
    status: "created" as const,
    worktreeMode: "isolated_install" as const,
  }),
);

afterAll(() => {
  getWorktreeSpy.mockRestore();
});

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "penumbra-reconciler-baseline-"));
  mainRepoDir = join(tempRoot, "main");
  branchWorktreeRoot = join(tempRoot, "branch");
  scratchRoot = join(tempRoot, "scratch");
  ensureRepoFixture(mainRepoDir);
  ensureRepoFixture(branchWorktreeRoot);
  materializeMainNodeModules();
  materializeNodeModules(branchWorktreeRoot);
  execHistory.length = 0;
  verdicts.length = 0;
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  mergeBaseSha = "c".repeat(40);
  branchTestOutcome = "pass";
  baseHasPreExistingFailure = false;
  holdBranchTestOpen = false;
  branchTestOutputOverride = null;
  baseTestOutputOverride = null;
  failBaselineInstall = false;
  timeoutBaselineInstall = false;
  contaminateBaselineConfigLink = false;
  materializeBranchLocalCache = false;
  observedBaselineNodeModulesIsSymlink = null;
  observedBaselineCoreIsSymlink = null;
  observedBaselineCoreRealpath = null;
  observedBaselineRootRealpath = null;
  observedBaselineLocalCacheRealpath = null;
  observedBaselineInstallOptions = null;
  omitBaselineCoreLinkDuringInstall = false;
  deps.mainRepoDir = mainRepoDir;
  deps.rebaseScratchRoot = scratchRoot;
  deps.settings = {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  };
  emitVerdict.mockClear();
  notifyResult.mockClear();
  postProgress.mockClear();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeReconciler(): ReturnType<typeof createMergeReconciler> {
  return createMergeReconciler(deps);
}

test("unhandled error between tests identifies the suite failure key", () => {
  const suitePath = "packages/daemon/test/sweepers/reconciler-sweep.test.ts";

  const report = parseBunTestReport(unhandledErrorOutput(suitePath, "52.34s"));

  expect(report.failureKeys).toContain(`error:${suitePath}`);
});

test("unhandled error failure key is stable across timing-only changes", () => {
  const suitePath = "packages/daemon/test/sweepers/reconciler-sweep.test.ts";
  const expectedKeys = [`error:${suitePath}`];

  const first = parseBunTestReport(unhandledErrorOutput(suitePath, "52.34s"));
  const second = parseBunTestReport(unhandledErrorOutput(suitePath, "53.04s"));

  expect(first.failureKeys).toEqual(expectedKeys);
  expect(second.failureKeys).toEqual(expectedKeys);
});

test("unhandled errors in different suites produce different failure keys", () => {
  const firstSuite = "packages/daemon/test/sweepers/reconciler-sweep.test.ts";
  const secondSuite = "packages/daemon/test/sweepers/notification-sweeper.test.ts";

  const first = parseBunTestReport(unhandledErrorOutput(firstSuite, "52.34s"));
  const second = parseBunTestReport(unhandledErrorOutput(secondSuite, "52.34s"));

  expect(first.failureKeys).toEqual([`error:${firstSuite}`]);
  expect(second.failureKeys).toEqual([`error:${secondSuite}`]);
  expect(first.failureKeys[0]).not.toBe(second.failureKeys[0]);
});

test("parsed unhandled error does not add a raw-output fallback key", () => {
  const suitePath = "packages/daemon/test/sweepers/reconciler-sweep.test.ts";

  const report = parseBunTestReport(unhandledErrorOutput(suitePath, "52.34s"));

  expect(report.failureKeys).toEqual([`error:${suitePath}`]);
  expect(report.failureKeys.some((key) => key.startsWith("unparsed:"))).toBe(false);
});

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
  expect(result.verification_environment_error).toBe(true);
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

test("summary-only baseline with matching branch failures is a test environment error", async () => {
  const suitePath = "packages/daemon/test/sweepers/reconciler-sweep.test.ts";
  mergeBaseSha = "m".repeat(40);
  branchTestOutputOverride = unhandledErrorOutput(suitePath, "1.00ms");
  baseTestOutputOverride = summaryOnlyUnhandledErrorOutput(suitePath);

  const result = await makeReconciler()("h-summary-only-baseline");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(result.regression_summary).not.toContain("scoped tests failed only with failures");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-summary-only-baseline",
    tests: "error",
  });
});

test("baseline scratch owns its node_modules", async () => {
  mergeBaseSha = "h".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;

  await makeReconciler()("h-baseline-isolated");

  expect(observedBaselineNodeModulesIsSymlink).toBe(false);
  expect(observedBaselineCoreRealpath?.startsWith(observedBaselineRootRealpath ?? "")).toBe(true);
});

test("baseline provisioning materializes workspace links after isolated install", async () => {
  mergeBaseSha = "h".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;
  omitBaselineCoreLinkDuringInstall = true;

  await makeReconciler()("h-baseline-workspace-links");

  expect(observedBaselineCoreIsSymlink).toBe(true);
  expect(observedBaselineCoreRealpath?.startsWith(observedBaselineRootRealpath ?? "")).toBe(true);
});

test("baseline installs from the merge-base lockfile", async () => {
  mergeBaseSha = "i".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;

  await makeReconciler()("h-baseline-install");

  expect(execHistory).toContainEqual({
    cmd: "bun install --ignore-scripts --frozen-lockfile",
    cwd: scratchPathFor("h-baseline-install"),
  });
});

test("contaminated baseline environment fails closed", async () => {
  mergeBaseSha = "j".repeat(40);
  baseTestOutputOverride = passOutput();
  branchTestOutputOverride = failOutput("daemon changed suite > newly fails", 10);
  contaminateBaselineConfigLink = true;

  const result = await makeReconciler()("h-baseline-contaminated");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(result.regression_summary).toContain("@penumbra/config");
  expect(result.regression_summary).not.toContain("new test failures");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-baseline-contaminated",
    tests: "error",
  });
});

test("baseline install failure fails closed", async () => {
  mergeBaseSha = "k".repeat(40);
  branchTestOutputOverride = failOutput("daemon changed suite > newly fails", 10);
  failBaselineInstall = true;

  const result = await makeReconciler()("h-baseline-install-fail");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(result.regression_summary).toContain("lockfile had changes");
  expect(result.regression_summary).not.toContain("new test failures");
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-baseline-install-fail",
    tests: "error",
  });
});

test("baseline install is bounded by the remaining tests-stage timeout", async () => {
  mergeBaseSha = "n".repeat(40);
  baseHasPreExistingFailure = true;
  branchTestOutcome = "pre-existing-fail";
  deps.settings = {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  };

  await makeReconciler()("h-baseline-install-timeout-options");

  expect(observedBaselineInstallOptions?.timeout).toBeGreaterThan(0);
  expect(observedBaselineInstallOptions?.timeout).toBeLessThanOrEqual(1000);
  expect(observedBaselineInstallOptions?.maxBuffer).toBe(1024 * 1024 * 10);
  expect(observedBaselineInstallOptions?.encoding).toBe("utf8");
});

test("timed-out baseline install fails closed as a test environment error", async () => {
  mergeBaseSha = "o".repeat(40);
  branchTestOutcome = "new-fail";
  timeoutBaselineInstall = true;
  deps.settings = {
    reconcileTypecheckTimeoutSec: 1,
    reconcileTestTimeoutSec: 1,
  };

  const result = await makeReconciler()("h-baseline-install-timeout");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(result.regression_summary).toContain("timed out");
  expect(observedBaselineInstallOptions?.timeout).toBeLessThanOrEqual(1000);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-baseline-install-timeout",
    tests: "error",
  });
});

test("failed baseline installs are retried on the next reconcile", async () => {
  mergeBaseSha = "p".repeat(40);
  branchTestOutcome = "pre-existing-fail";
  baseHasPreExistingFailure = true;
  failBaselineInstall = true;

  const first = await makeReconciler()("h-baseline-install-retry-a");
  expect(first.status).toBe("test_failed");
  expect(first.verification_environment_error).toBe(true);
  expect(first.regression_summary).toContain("verification environment error (tests)");

  failBaselineInstall = false;
  const second = await makeReconciler()("h-baseline-install-retry-b");

  expect(second.status).toBe("verified");
});

test("baseline cache key changes when the merge-base lockfile changes", async () => {
  mergeBaseSha = "q".repeat(40);
  branchTestOutputOverride = failOutput("daemon existing suite > already fails");
  baseTestOutputOverride = failOutput("daemon existing suite > already fails");

  const first = await makeReconciler()("h-baseline-lock-cache-a");
  expect(first.status).toBe("verified");

  writeFileSync(join(mainRepoDir, "bun.lock"), "changed-lockfile\n");
  baseTestOutputOverride = passOutput();
  const second = await makeReconciler()("h-baseline-lock-cache-b");

  expect(second.status).toBe("test_failed");
  expect(second.regression_summary).toContain("new test failures");
});

test("local_cache is provisioned into branch and baseline test environments", async () => {
  mergeBaseSha = "l".repeat(40);
  baseTestOutputOverride = healthyBranchRaw;
  branchTestOutputOverride = healthyBranchRaw;
  mkdirSync(join(mainRepoDir, "local_cache"), { recursive: true });
  writeFileSync(join(mainRepoDir, "local_cache", "fastembed.bin"), "cache");

  await makeReconciler()("h-baseline-cache");

  expect(realpathSync(join(branchWorktreeRoot, "local_cache"))).not.toBe(
    realpathSync(join(mainRepoDir, "local_cache")),
  );
  expect(readFileSync(join(branchWorktreeRoot, "local_cache", "fastembed.bin"), "utf8")).toBe(
    "cache",
  );
  expect(observedBaselineLocalCacheRealpath).not.toBe(
    realpathSync(join(mainRepoDir, "local_cache")),
  );
});

test("passing branch run with symlinked node_modules fails closed before tests execute", async () => {
  rmSync(join(branchWorktreeRoot, "node_modules"), { recursive: true, force: true });
  symlinkSync(join(mainRepoDir, "node_modules"), join(branchWorktreeRoot, "node_modules"), "dir");

  const result = await makeReconciler()("h-branch-contaminated-pass");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toContain("verification environment error (tests)");
  expect(result.regression_summary).toContain("node_modules is a symlink");
  expect(result.regression_summary).toContain("isolated install");
  expect(execHistory.some(({ cmd }) => cmd.startsWith("bun test"))).toBe(false);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-branch-contaminated-pass",
    tests: "error",
  });
});

test("branch local cache provisioning environment failure is not attributed to dispatched code", async () => {
  deps.mainRepoDir = branchWorktreeRoot;

  const result = await makeReconciler()("h-branch-cache-provision-env");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(result.regression_summary).toStartWith("verification environment error (tests): ");
  expect(result.regression_summary).toContain(
    "local cache source and destination resolve to the same path",
  );
  expect(execHistory.some(({ cmd }) => cmd.startsWith("bun test"))).toBe(false);
  expect(verdicts[0]).toMatchObject({
    handoff_id: "h-branch-cache-provision-env",
    tests: "error",
  });
});

test("branch local cache provisioning command failure stays attributable", async () => {
  const provisionLocalCacheSpy = spyOn(core, "provisionLocalCache").mockImplementation(() => {
    throw new ExecCommandError({ stderr: "local cache copy failed\n", code: 1 });
  });

  try {
    const result = await makeReconciler()("h-branch-cache-provision-fail");

    expect(result.status).toBe("test_failed");
    expect(result.verification_environment_error).toBeUndefined();
    expect(result.regression_summary).toBe("local cache copy failed\n");
    expect(execHistory.some(({ cmd }) => cmd.startsWith("bun test"))).toBe(false);
    expect(verdicts[0]).toMatchObject({
      handoff_id: "h-branch-cache-provision-fail",
      tests: "fail",
    });
  } finally {
    provisionLocalCacheSpy.mockRestore();
  }
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
