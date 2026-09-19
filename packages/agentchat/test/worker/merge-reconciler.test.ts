import {
  type HandoffRow,
  type Logger,
  MergeResultEventSchema,
  WorktreeManager,
} from "@penumbra/core";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraHttpError } from "@src/penumbra-client.js";
import type { CreatePRArgs, CreatePRResult } from "@src/worker/github-pr-helper.js";
import {
  createMergeReconciler,
  MERGE_RESULT_STATUSES,
  type MergeResult,
  type ReconcilerDeps,
  type ReconcilerVerdict,
  resolveAffectedPackages,
} from "@src/worker/merge-reconciler.js";
import type { ThoughtAnalyzerInput, ThoughtRow } from "@src/worker/thought-analyzer.js";
import type { RuntimeThoughtsConfig } from "@src/worker/thought-config.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

// Errors thrown from the exec mock carry stderr/stdout/code so the production
// runGitProbe / catch blocks can read them via duck-typing. A real Error subclass
// keeps the throw-site compatible with `@typescript-eslint/only-throw-error`.
class ExecCommandError extends Error {
  public readonly stderr: string;
  public readonly stdout: string;
  public readonly code: number | undefined;
  constructor(init: { stderr?: string; stdout?: string; code?: number } = {}) {
    super(init.stderr ?? "");
    this.name = "ExecCommandError";
    this.stderr = init.stderr ?? "";
    this.stdout = init.stdout ?? "";
    this.code = init.code;
  }
}

// HandoffRow's Zod preprocessors make the inferred TS type narrower than the
// runtime schema accepts. ONE documented `as unknown as HandoffRow` cast in
// this typed factory bridges that gap once for every fixture.
function makeHandoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  const base = {
    handoff_id: "h1",
    ts: "2026-04-28T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-456",
    from_agent: "user",
    to_agent: "codex-mini",
    to_role: null,
    message: "dispatch prompt",
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
  };
  return base as unknown as HandoffRow;
}

// Pino's Logger has many methods; the reconciler only calls info/warn/debug/error.
// ONE documented `as unknown as Logger` cast inside this factory keeps the rest
// of the file Logger-typed without re-implementing the full pino surface.
const logMocks = {
  info: mock((..._args: unknown[]) => undefined),
  debug: mock((..._args: unknown[]) => undefined),
  error: mock((..._args: unknown[]) => undefined),
  warn: mock((..._args: unknown[]) => undefined),
};

function makeTestLogger(): Logger {
  return logMocks as unknown as Logger;
}

interface ProgressCall {
  id: string;
  payload: unknown;
}

interface PRCallRecord {
  args: CreatePRArgs;
}

const progressCalls: ProgressCall[] = [];
const verdictCalls: ReconcilerVerdict[] = [];
const execHistory: string[] = [];
const prCalls: PRCallRecord[] = [];
const handoffRows = new Map<string, HandoffRow>();
const execFailures = new Map<string, ExecCommandError>();
let defaultWorktreeRoot = "";
let nextExecResult: ExecResult = { stdout: "", stderr: "" };
let createDispatchPRFailOnCall: number | null = null;
let createDispatchPRCallCount = 0;
let createDispatchPRDelayMs = 0;
const defaultDiffResult: ExecResult = {
  stdout: "packages/daemon/src/routes/handoffs.ts\n",
  stderr: "",
};
const defaultShortStat: ExecResult = {
  stdout: " 1 file changed, 2 insertions(+), 1 deletion(-)\n",
  stderr: "",
};
const defaultBaseTipSha = "a".repeat(40);
const defaultBranchHeadSha = "b".repeat(40);
const defaultMergeBaseSha = "c".repeat(40);

const postProgressMock = mock((id: string, payload: unknown): Promise<void> => {
  progressCalls.push({ id, payload });
  return Promise.resolve();
});

const notifyResultMock = mock((_id: string, _result: MergeResult) => Promise.resolve());
const captureResultMock = mock((_id: string, _result: MergeResult) => Promise.resolve());

const emitVerdictMock = mock((verdict: ReconcilerVerdict): Promise<void> => {
  verdictCalls.push(verdict);
  return Promise.resolve();
});

const getHandoffMock = mock((id: string): Promise<HandoffRow | null> => {
  return Promise.resolve(handoffRows.get(id) ?? null);
});

const createDispatchPRMock = mock(
  async (args: CreatePRArgs, _log: Logger): Promise<CreatePRResult> => {
    createDispatchPRCallCount += 1;
    prCalls.push({ args });
    if (createDispatchPRDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, createDispatchPRDelayMs));
    }
    if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
      throw new Error("Boom");
    }
    return {
      url: "https://github.com/frozename/penumbra/pull/321",
      number: 321,
    };
  },
);

function defaultExecForCommand(cmd: string): Promise<ExecResult> {
  if (cmd === "git rev-parse HEAD") {
    return Promise.resolve({ stdout: `${defaultBranchHeadSha}\n`, stderr: "" });
  }

  if (cmd.startsWith("git rev-parse ")) {
    return Promise.resolve({ stdout: `${defaultBaseTipSha}\n`, stderr: "" });
  }

  if (cmd.startsWith("git merge-base ") && !cmd.startsWith("git merge-base --is-ancestor")) {
    return Promise.resolve({ stdout: `${defaultMergeBaseSha}\n`, stderr: "" });
  }

  if (cmd.startsWith("git diff --name-only")) {
    return Promise.resolve(defaultDiffResult);
  }

  if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
    return Promise.resolve(defaultShortStat);
  }

  for (const [pattern, error] of execFailures) {
    if (cmd.includes(pattern)) return Promise.reject(error);
  }

  return Promise.resolve(nextExecResult);
}

function defaultExec(argv: string[], _opts: { cwd: string }): Promise<ExecResult> {
  const cmd = argv.join(" ");
  execHistory.push(cmd);
  return defaultExecForCommand(cmd);
}

const execMock = mock(defaultExec);

const mockDeps: ReconcilerDeps = {
  worktreeManager: new WorktreeManager(),
  postProgress: postProgressMock,
  notifyResult: notifyResultMock,
  captureResult: captureResultMock,
  emitVerdict: emitVerdictMock,
  log: makeTestLogger(),
  mainRepoDir: "/main/repo",
  getHandoff: getHandoffMock,
  createDispatchPR: createDispatchPRMock,
  exec: execMock,
  rebaseScratchRoot: "/tmp/penumbra-rebase-scratch",
  settings: {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  },
};

const getWorktreeSpy = spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation(
  (id: string) => {
    if (id === "missing") return null;
    const path = defaultWorktreeRoot ? join(defaultWorktreeRoot, id) : `/worktree/${id}`;
    if (defaultWorktreeRoot) materializeOwnedNodeModules(path);
    return {
      handoffId: id,
      path,
      branchName: `agent/${id}`,
      storageRoot: join(path, ".test-storage"),
      createdAt: "",
      status: "created" as const,
      worktreeMode: "isolated_install" as const,
    };
  },
);

afterAll(() => {
  getWorktreeSpy.mockRestore();
});

function materializeOwnedNodeModules(root: string): void {
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  mkdirSync(join(root, "packages", "config"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@penumbra"), { recursive: true });
  const coreLink = join(root, "node_modules", "@penumbra", "core");
  const configLink = join(root, "node_modules", "@penumbra", "config");
  rmSync(coreLink, { recursive: true, force: true });
  rmSync(configLink, { recursive: true, force: true });
  symlinkSync(join(root, "packages", "core"), coreLink, "dir");
  symlinkSync(join(root, "packages", "config"), configLink, "dir");
}

beforeEach(() => {
  defaultWorktreeRoot = mkdtempSync(join(tmpdir(), "penumbra-reconciler-default-wt-"));
  logMocks.info.mockClear();
  logMocks.debug.mockClear();
  logMocks.error.mockClear();
  logMocks.warn.mockClear();
  progressCalls.length = 0;
  verdictCalls.length = 0;
  execHistory.length = 0;
  prCalls.length = 0;
  createDispatchPRCallCount = 0;
  createDispatchPRDelayMs = 0;
  createDispatchPRFailOnCall = null;
  nextExecResult = { stdout: "", stderr: "" };
  execFailures.clear();
  handoffRows.clear();
  execMock.mockImplementation(defaultExec);
  createDispatchPRMock.mockImplementation(
    async (args: CreatePRArgs, _log: Logger): Promise<CreatePRResult> => {
      createDispatchPRCallCount += 1;
      prCalls.push({ args });
      if (createDispatchPRDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, createDispatchPRDelayMs));
      }
      if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
        throw new Error("Boom");
      }
      return {
        url: "https://github.com/frozename/penumbra/pull/321",
        number: 321,
      };
    },
  );
  getHandoffMock.mockImplementation(
    (id: string): Promise<HandoffRow | null> => Promise.resolve(handoffRows.get(id) ?? null),
  );
  notifyResultMock.mockReset();
  notifyResultMock.mockImplementation(() => Promise.resolve());
  captureResultMock.mockReset();
  captureResultMock.mockImplementation(() => Promise.resolve());
  emitVerdictMock.mockReset();
  emitVerdictMock.mockImplementation((verdict: ReconcilerVerdict) => {
    verdictCalls.push(verdict);
    return Promise.resolve();
  });
  mockDeps.thoughtsConfig = undefined;
  mockDeps.thoughtAnalyzerDeps = undefined;
  mockDeps.runThoughtAnalyzer = undefined;
  mockDeps.listThoughtEvents = undefined;
  mockDeps.getParentHandoffId = undefined;
  mockDeps.settings = {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  };
});

afterEach(() => {
  if (defaultWorktreeRoot) {
    rmSync(defaultWorktreeRoot, { recursive: true, force: true });
    defaultWorktreeRoot = "";
  }
});

const reconcile = createMergeReconciler(mockDeps);

test("worker merge result statuses round-trip through the daemon SSE schema", () => {
  expect(Object.isFrozen(MERGE_RESULT_STATUSES)).toBe(true);
  for (const status of MERGE_RESULT_STATUSES) {
    expect(
      MergeResultEventSchema.safeParse({
        type: "merge-result",
        handoff_id: "h-contract",
        status,
      }).success,
    ).toBe(true);
  }
});

function thoughtsConfigEnabled(onlyWhen: string[] = ["pr_opened"]): RuntimeThoughtsConfig {
  return {
    enabled: true,
    capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
    analyze: {
      enabled: true,
      onlyWhen,
      digest: { enabled: true, pool: "local-gemma26", maxInputChars: 1000, timeoutMs: 5000 },
      signals: {
        enabled: false,
        pool: "local-gemma26",
        timeoutMs: 5000,
        maxInputChars: null,
        definitions: [],
      },
    },
  };
}

test("default reconcile verifies and emits verdict without opening PR", async () => {
  handoffRows.set(
    "h1",
    makeHandoffRow({
      handoff_id: "h1",
      conversation_id: "c-456",
      to_agent: "codex-mini",
      message: "dispatch prompt with $(touch /tmp/pwned) literally",
      open_pr_on_review: false,
    }),
  );

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(result.pr_url).toBeUndefined();
  expect(result.pr_number).toBeUndefined();
  expect(execHistory).toContain("bun tsc -b packages/core packages/daemon");
  expect(execHistory).toContain("bun test packages/daemon/test/");
  expect(execHistory).toContain(
    `git diff ${defaultMergeBaseSha}...${defaultBranchHeadSha} --shortstat`,
  );
  expect(prCalls).toHaveLength(0);
  expect(logMocks.info).toHaveBeenCalledWith(
    expect.objectContaining({
      handoffId: "h1",
      branch: "agent/h1",
    }),
    expect.stringMatching(/verified/),
  );
  expect(progressCalls).toContainEqual({
    id: "h1",
    payload: {
      type: "merge-result",
      handoff_id: "h1",
      status: "verified",
    },
  });
  expect(notifyResultMock).toHaveBeenCalledWith("h1", {
    status: "verified",
    progressReported: true,
  });
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h1",
    conversation_id: "c-456",
    branch: "agent/h1",
    typecheck: "pass",
    tests: "pass",
    files_changed: 1,
    lines_added: 2,
    lines_deleted: 1,
    ff_mergeable: expect.any(Boolean) as unknown,
    rebase_required: expect.any(Boolean) as unknown,
    rebase_attempted: false,
    rebase_result: "skipped",
    pr_url: null,
    duration_ms: expect.any(Number) as unknown,
    summary: expect.any(String) as unknown,
  });
  expect(typeof verdictCalls[0]?.verified_at).toBe("string");
  expect(verdictCalls[0]?.verified_at).toMatch(/Z$/);
});

test("ff_mergeable=false rebase success emits success verdict with rebased branch", async () => {
  let mergeBaseCalls = 0;
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) return Promise.resolve(defaultDiffResult);
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat"))
      return Promise.resolve(defaultShortStat);
    if (cmd === "git merge-base --is-ancestor main agent/h_rebase_ok") {
      mergeBaseCalls += 1;
      if (mergeBaseCalls === 1)
        return Promise.reject(new ExecCommandError({ stderr: "not-ancestor", code: 1 }));
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (cmd === "git rev-parse agent/h_rebase_ok") {
      return Promise.resolve({ stdout: "rebased-sha\n", stderr: "" });
    }
    if (cmd === `git merge-base --is-ancestor ${defaultBaseTipSha} ${defaultBranchHeadSha}`) {
      mergeBaseCalls += 1;
      if (mergeBaseCalls === 1)
        return Promise.reject(new ExecCommandError({ stderr: "not-ancestor", code: 1 }));
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_rebase_ok");

  expect(result.status).toBe("verified");
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_rebase_ok",
    ff_mergeable: true,
    rebase_required: false,
    rebase_attempted: true,
    rebase_result: "success",
    rebased_branch: "agent/h_rebase_ok",
  });
  for (const expected of [
    "git worktree remove --force /tmp/penumbra-rebase-scratch/h_rebase_ok",
    `git worktree add --detach /tmp/penumbra-rebase-scratch/h_rebase_ok ${defaultBaseTipSha}`,
    "git checkout agent/h_rebase_ok",
    `git rebase ${defaultBaseTipSha}`,
    "git rev-parse agent/h_rebase_ok",
    `git merge-base --is-ancestor ${defaultBaseTipSha} rebased-sha`,
    "git push --force-with-lease origin agent/h_rebase_ok:agent/h_rebase_ok",
  ]) {
    expect(execHistory).toContain(expected);
  }
});

test("ff_mergeable=false rebase conflict emits conflict verdict with file list", async () => {
  execFailures.set(
    `git merge-base --is-ancestor ${defaultBaseTipSha} ${defaultBranchHeadSha}`,
    new ExecCommandError({ stderr: "not-ancestor", code: 1 }),
  );
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd === "git diff --name-only --diff-filter=U")
      return Promise.resolve({ stdout: "a.ts\nb.ts\n", stderr: "" });
    if (cmd.startsWith("git diff --name-only")) return Promise.resolve(defaultDiffResult);
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat"))
      return Promise.resolve(defaultShortStat);
    if (cmd === `git rebase ${defaultBaseTipSha}`)
      return Promise.reject(new ExecCommandError({ stderr: "CONFLICT" }));
    for (const [pattern, error] of execFailures) {
      if (cmd.includes(pattern)) return Promise.reject(error);
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_rebase_conflict");

  expect(result.status).toBe("verified");
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_rebase_conflict",
    ff_mergeable: false,
    rebase_required: true,
    rebase_attempted: true,
    rebase_result: "conflict",
    rebase_conflict_files: ["a.ts", "b.ts"],
  });
  for (const expected of [
    "git worktree remove --force /tmp/penumbra-rebase-scratch/h_rebase_conflict",
    `git worktree add --detach /tmp/penumbra-rebase-scratch/h_rebase_conflict ${defaultBaseTipSha}`,
    "git checkout agent/h_rebase_conflict",
    `git rebase ${defaultBaseTipSha}`,
    "git diff --name-only --diff-filter=U",
    "git rebase --abort",
  ]) {
    expect(execHistory).toContain(expected);
  }
});

test("reconcilerAutoRebase=false skips rebase even when ff_mergeable=false", async () => {
  execFailures.set(
    `git merge-base --is-ancestor ${defaultBaseTipSha} ${defaultBranchHeadSha}`,
    new ExecCommandError({ stderr: "not-ancestor", code: 1 }),
  );
  const reconcileNoAuto = createMergeReconciler({
    ...mockDeps,
    reconcilerAutoRebase: false,
  });

  const result = await reconcileNoAuto("h_rebase_disabled");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.includes("git worktree add --detach"))).toBe(false);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_rebase_disabled",
    ff_mergeable: false,
    rebase_required: true,
    rebase_attempted: false,
    rebase_result: "skipped",
  });
});

test("opens PR only when handoff open_pr_on_review is true", async () => {
  handoffRows.set(
    "h1",
    makeHandoffRow({
      handoff_id: "h1",
      conversation_id: "c-456",
      to_agent: "codex-mini",
      message: "dispatch prompt with $(touch /tmp/pwned) literally",
      open_pr_on_review: true,
    }),
  );

  const result = await reconcile("h1");
  expect(result.status).toBe("pr_opened");
  expect(prCalls).toHaveLength(1);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]?.pr_url).toBe("https://github.com/frozename/penumbra/pull/321");
});

test("reconciler posts successful results to capture dependency", async () => {
  captureResultMock.mockReset();
  captureResultMock.mockImplementation(() => Promise.resolve());
  const result = await reconcile("h1");
  expect(result.status).toBe("verified");
  expect(captureResultMock).toHaveBeenCalledWith("h1", {
    status: "verified",
    progressReported: true,
  });
});

test("capture dependency failure does not change reconciler result", async () => {
  captureResultMock.mockReset();
  captureResultMock.mockImplementation(() => Promise.reject(new Error("capture down")));
  const result = await reconcile("h1");
  expect(result.status).toBe("verified");
  expect(notifyResultMock).toHaveBeenCalled();
});

test("progress post failure does not mask the verified reconciler result", async () => {
  const captureResult = mock((_id: string, _result: MergeResult) => Promise.resolve());
  const emitVerdict = mock((_verdict: ReconcilerVerdict) => Promise.resolve());
  const notifyResult = mock((_id: string, _result: MergeResult) => Promise.resolve());
  const reconcileWithProgressFailure = createMergeReconciler({
    ...mockDeps,
    postProgress: mock(() =>
      Promise.reject(
        new PenumbraHttpError("penumbra /handoffs/h1/progress: HTTP 400", 400, {
          error: { code: "validation_failed" },
          field_errors: [{ path: ["status"], message: "Invalid enum value" }],
        }),
      ),
    ),
    captureResult,
    emitVerdict,
    notifyResult,
  });

  const result = await reconcileWithProgressFailure("h1");

  expect(result.status).toBe("verified");
  expect(result.progressReported).toBe(false);
  expect(captureResult).toHaveBeenCalledWith("h1", {
    status: "verified",
    progressReported: false,
  });
  expect(emitVerdict.mock.calls[0]?.[0]).toMatchObject({
    handoff_id: "h1",
    typecheck: "pass",
    tests: "pass",
    progressReported: false,
  });
  expect(notifyResult).toHaveBeenCalledWith("h1", {
    status: "verified",
    progressReported: false,
  });
  const warning = logMocks.warn.mock.calls.find(
    (call) => call[1] === "merge-result progress post failed",
  );
  expect(warning).toBeDefined();
  expect(warning?.[0]).toMatchObject({
    handoffId: "h1",
    status: 400,
    body: { error: { code: "validation_failed" } },
  });
});

test("runs thought analyzer after notifyResult when merge status is in onlyWhen", async () => {
  const callOrder: string[] = [];
  const thoughtRows: ThoughtRow[] = [
    { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
  ];

  notifyResultMock.mockImplementation(() => {
    callOrder.push("notifyResult");
    return Promise.resolve();
  });
  mockDeps.getParentHandoffId = mock((_id: string) => Promise.resolve<string | null>(null));
  mockDeps.listThoughtEvents = mock((_id: string) => {
    callOrder.push("listThoughtEvents");
    return Promise.resolve(thoughtRows);
  });
  mockDeps.runThoughtAnalyzer = mock((input: ThoughtAnalyzerInput) => {
    callOrder.push("runThoughtAnalyzer");
    expect(input).toMatchObject({
      handoffId: "h1",
      thoughts: thoughtRows,
      mergeStatus: "verified",
      config: mockDeps.thoughtsConfig,
      deps: mockDeps.thoughtAnalyzerDeps,
    });
    return Promise.resolve();
  });
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(() => Promise.resolve({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(() => Promise.resolve({ status: "completed" as const })),
    chainResponse: mock(() => Promise.resolve({ responses: [] })),
    recordEvent: mock(() => Promise.resolve()),
    log: makeTestLogger(),
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(notifyResultMock).toHaveBeenCalledTimes(1);
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).toHaveBeenCalledWith("h1");
  expect(mockDeps.runThoughtAnalyzer).toHaveBeenCalledTimes(1);
  expect(callOrder).toEqual(["notifyResult", "listThoughtEvents", "runThoughtAnalyzer"]);
});

test("skips the analyzer when merge status is not in onlyWhen", async () => {
  mockDeps.listThoughtEvents = mock(() =>
    Promise.resolve<ThoughtRow[]>([
      { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
    ]),
  );
  mockDeps.runThoughtAnalyzer = mock(() => Promise.resolve());
  mockDeps.getParentHandoffId = mock(() => Promise.resolve<string | null>(null));
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["test_failed"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(() => Promise.resolve({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(() => Promise.resolve({ status: "completed" as const })),
    chainResponse: mock(() => Promise.resolve({ responses: [] })),
    recordEvent: mock(() => Promise.resolve()),
    log: makeTestLogger(),
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).not.toHaveBeenCalled();
  expect(mockDeps.listThoughtEvents).not.toHaveBeenCalled();
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("skips the analyzer when there are no thought events", async () => {
  mockDeps.getParentHandoffId = mock(() => Promise.resolve<string | null>(null));
  mockDeps.listThoughtEvents = mock(() => Promise.resolve<ThoughtRow[]>([]));
  mockDeps.runThoughtAnalyzer = mock(() => Promise.resolve());
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(() => Promise.resolve({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(() => Promise.resolve({ status: "completed" as const })),
    chainResponse: mock(() => Promise.resolve({ responses: [] })),
    recordEvent: mock(() => Promise.resolve()),
    log: makeTestLogger(),
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).toHaveBeenCalledWith("h1");
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("skips the analyzer for sub-handoff dispatches (parent_handoff_id non-null)", async () => {
  mockDeps.getParentHandoffId = mock(() => Promise.resolve<string | null>("parent-123"));
  mockDeps.listThoughtEvents = mock(() =>
    Promise.resolve<ThoughtRow[]>([
      { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
    ]),
  );
  mockDeps.runThoughtAnalyzer = mock(() => Promise.resolve());
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(() => Promise.resolve({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(() => Promise.resolve({ status: "completed" as const })),
    chainResponse: mock(() => Promise.resolve({ responses: [] })),
    recordEvent: mock(() => Promise.resolve()),
    log: makeTestLogger(),
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).not.toHaveBeenCalled();
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("does not throw when analyzer throws — logs and continues", async () => {
  mockDeps.getParentHandoffId = mock(() => Promise.resolve<string | null>(null));
  mockDeps.listThoughtEvents = mock(() =>
    Promise.resolve<ThoughtRow[]>([
      { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
    ]),
  );
  mockDeps.runThoughtAnalyzer = mock(() => Promise.reject(new Error("analyzer blew up")));
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(() => Promise.resolve({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(() => Promise.resolve({ status: "completed" as const })),
    chainResponse: mock(() => Promise.resolve({ responses: [] })),
    recordEvent: mock(() => Promise.resolve()),
    log: makeTestLogger(),
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.runThoughtAnalyzer).toHaveBeenCalledTimes(1);
  expect(logMocks.warn).toHaveBeenCalledWith(
    { handoffId: "h1", err: "Error: analyzer blew up" },
    "thought analyzer failed",
  );
});

test("Typecheck fail: returns typecheck_failed and skips PR creation", async () => {
  execFailures.set(
    "bun tsc -b packages/core packages/daemon",
    new ExecCommandError({ stderr: "Syntax error" }),
  );

  const result = await reconcile("h2");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toBe("packages/core, packages/daemon: Syntax error");
  expect(execHistory).toContain("bun tsc -b packages/core packages/daemon");
  expect(execHistory).not.toContain("bun test");
  expect(prCalls).toHaveLength(0);
  expect(progressCalls).toContainEqual({
    id: "h2",
    payload: {
      type: "merge-result",
      handoff_id: "h2",
      status: "typecheck_failed",
      regression_summary: "packages/core, packages/daemon: Syntax error",
    },
  });
  expect(notifyResultMock).toHaveBeenCalledWith("h2", {
    status: "typecheck_failed",
    regression_summary: "packages/core, packages/daemon: Syntax error",
    progressReported: true,
  });
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h2",
    typecheck: "fail",
    tests: "skipped",
    pr_url: null,
  });
});

test("reconciler diffs against a fixed merge-base and worktree head snapshot", async () => {
  const baseTip = "a".repeat(40);
  const branchTip = "b".repeat(40);
  const mergeBase = "c".repeat(40);

  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd === "git rev-parse HEAD") {
      return Promise.resolve({ stdout: `${branchTip}\n`, stderr: "" });
    }
    if (cmd === "git rev-parse main") {
      return Promise.resolve({ stdout: `${baseTip}\n`, stderr: "" });
    }
    if (cmd === `git merge-base ${baseTip} ${branchTip}`) {
      return Promise.resolve({ stdout: `${mergeBase}\n`, stderr: "" });
    }
    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({
        stdout: "packages/daemon/src/routes/handoffs.ts\npackages/core/src/index.ts\n",
        stderr: "",
      });
    }
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      if (cmd === `git diff ${mergeBase}...${branchTip} --shortstat`) {
        return Promise.resolve({
          stdout: " 2 files changed, 5 insertions(+), 1 deletion(-)\n",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_snapshot");

  expect(result.status).toBe("verified");
  expect(execHistory).toContain(`git merge-base ${baseTip} ${branchTip}`);
  expect(execHistory).toContain(`git diff --name-only ${mergeBase}...${branchTip}`);
  expect(execHistory).toContain(`git diff ${mergeBase}...${branchTip} --shortstat`);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_snapshot",
    head_sha: branchTip,
    base_sha: baseTip,
    files_changed: 2,
    lines_added: 5,
    lines_deleted: 1,
    typecheck: "pass",
    tests: "pass",
  });
});

test("full-repo typecheck runs direct tsc build, not the dist-freshness-gated script", async () => {
  // A non-package diff forces the unscoped full-repo verification path.
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({ stdout: "README.md\n", stderr: "" });
    }
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return Promise.resolve(defaultShortStat);
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_full_tc_pass");

  expect(result.status).toBe("verified");
  expect(execHistory).toContain("bun tsc -b");
  expect(execHistory).not.toContain("bun run typecheck");
  expect(execHistory.some((cmd) => cmd.includes("check-dist-freshness"))).toBe(false);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_full_tc_pass",
    typecheck: "pass",
  });
});

test("full-repo typecheck still fails on a real tsc diagnostic", async () => {
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({ stdout: "README.md\n", stderr: "" });
    }
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return Promise.resolve(defaultShortStat);
    }
    if (cmd === "bun tsc -b") {
      return Promise.reject(
        new ExecCommandError({
          stdout: "packages/core/src/broken.ts(12,3): error TS2304: Cannot find name 'foo'.\n",
          code: 2,
        }),
      );
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_full_tc_fail");

  expect(result.status).toBe("typecheck_failed");
  expect(execHistory).toContain("bun tsc -b");
  expect(execHistory).not.toContain("bun run typecheck");
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_full_tc_fail",
    typecheck: "fail",
  });
});

test("head/base mismatch with persistently empty diff does not emit hard-fail verdict", async () => {
  const baseTip = "1".repeat(40);
  const branchTip = "2".repeat(40);
  const mergeBase = "3".repeat(40);

  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd === "git rev-parse HEAD" || cmd === "git rev-parse agent/h_empty_diff_fail") {
      return Promise.resolve({ stdout: `${branchTip}\n`, stderr: "" });
    }
    if (cmd === "git rev-parse main") {
      return Promise.resolve({ stdout: `${baseTip}\n`, stderr: "" });
    }
    if (cmd === `git merge-base ${baseTip} ${branchTip}`) {
      return Promise.resolve({ stdout: `${mergeBase}\n`, stderr: "" });
    }
    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({ stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" });
    }
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (cmd.startsWith("bun tsc -b")) {
      return Promise.reject(new ExecCommandError({ stderr: "Syntax error", code: 2 }));
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_empty_diff_fail");

  expect(result.status).toBe("typecheck_failed");
  expect(result.verification_environment_error).toBeUndefined();
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_empty_diff_fail",
    head_sha: branchTip,
    base_sha: baseTip,
    files_changed: 0,
    typecheck: "error",
    tests: "skipped",
  });
  expect(verdictCalls[0]?.summary).toContain("verification-error");
  expect(verdictCalls[0]?.summary).not.toContain("verification-failed");
  expect(
    execHistory.filter((cmd) => cmd === `git diff ${mergeBase}...${branchTip} --shortstat`),
  ).toHaveLength(2);
});

test("Typecheck environment failure (empty-output exec error): stamps 'error' not 'fail', logs the break", async () => {
  execFailures.set("git diff --name-only", new ExecCommandError({}));
  execFailures.set("bun tsc -b packages/core packages/daemon", new ExecCommandError({}));

  const result = await reconcile("h-env-tc");

  expect(result.status).toBe("typecheck_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h-env-tc",
    typecheck: "error",
    tests: "skipped",
  });
  expect(logMocks.warn).toHaveBeenCalled();
});

test("Test fail: returns test_failed and skips PR creation", async () => {
  execFailures.set("bun test", new ExecCommandError({ stderr: "1 test failed" }));

  const result = await reconcile("h3");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBeUndefined();
  expect(result.regression_summary).toBe("1 test failed");
  expect(execHistory).toContain("bun tsc -b packages/core packages/daemon");
  expect(execHistory).toContain("bun test packages/daemon/test/");
  expect(prCalls).toHaveLength(0);
  expect(notifyResultMock).toHaveBeenCalledWith("h3", {
    status: "test_failed",
    regression_summary: "1 test failed",
    progressReported: true,
  });
});

test("Test environment failure (empty-output exec error): stamps 'error' not 'fail'", async () => {
  execFailures.set("bun test", new ExecCommandError({}));

  const result = await reconcile("h-env-test");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBe(true);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h-env-test",
    typecheck: "pass",
    tests: "error",
  });
});

test("genuine test failure downgraded to verdict error does not get the environment flag", async () => {
  const baseTip = "4".repeat(40);
  const branchTip = "5".repeat(40);
  const mergeBase = "6".repeat(40);

  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd === "git rev-parse HEAD" || cmd === "git rev-parse agent/h_empty_diff_test_fail") {
      return Promise.resolve({ stdout: `${branchTip}\n`, stderr: "" });
    }
    if (cmd === "git rev-parse main") {
      return Promise.resolve({ stdout: `${baseTip}\n`, stderr: "" });
    }
    if (cmd === `git merge-base ${baseTip} ${branchTip}`) {
      return Promise.resolve({ stdout: `${mergeBase}\n`, stderr: "" });
    }
    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({ stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" });
    }
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (cmd.startsWith("bun test")) {
      return Promise.reject(new ExecCommandError({ stderr: "1 test failed", code: 1 }));
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_empty_diff_test_fail");

  expect(result.status).toBe("test_failed");
  expect(result.verification_environment_error).toBeUndefined();
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_empty_diff_test_fail",
    tests: "error",
  });
  expect(notifyResultMock).toHaveBeenCalledWith("h_empty_diff_test_fail", {
    status: "test_failed",
    regression_summary: "1 test failed",
    progressReported: true,
  });
});

function baselinePassOutput(): string {
  return `(pass) daemon suite > already passes [1.00ms]

 1 pass
 0 fail
 0 error
Ran 1 tests across 1 files. [2.00ms]
`;
}

function baselineFailOutput(name = "daemon suite > already fails"): string {
  return `(fail) ${name} [1.00ms]
error: expect(received).toBe(expected)

 0 pass
 1 fail
 0 error
Ran 1 tests across 1 files. [2.00ms]
`;
}

interface BaselineProvisioningScenarioOpts {
  handoffId: string;
  mergeBaseSha: string;
  branchOutput?: string;
  baselineOutput?: string;
  contaminateBaselineConfigLink?: boolean;
  failBaselineInstall?: boolean;
  createLocalCache?: boolean;
}

interface BaselineProvisioningScenarioResult {
  result: MergeResult;
  execCalls: { cmd: string; cwd: string }[];
  observedBaselineNodeModulesIsSymlink: boolean | null;
  observedBaselineCoreRealpath: string | null;
  observedBaselineRootRealpath: string | null;
  observedBaselineLocalCacheRealpath: string | null;
  observedBranchLocalCacheRealpath: string | null;
  observedBranchLocalCacheHasSeed: boolean;
  observedBaselineLocalCacheHasSeed: boolean;
  mainLocalCacheRealpath: string | null;
  baselineScratchPath: string;
}

async function runBaselineProvisioningScenario(
  opts: BaselineProvisioningScenarioOpts,
): Promise<BaselineProvisioningScenarioResult> {
  const tempRoot = mkdtempSync(join(tmpdir(), "penumbra-merge-baseline-"));
  const mainRepoDir = join(tempRoot, "main");
  const branchRoot = join(tempRoot, "branch");
  const scratchRoot = join(tempRoot, "scratch");
  const baselineScratchPath = join(scratchRoot, "test-baseline", opts.handoffId);
  const execCalls: { cmd: string; cwd: string }[] = [];
  let observedBaselineNodeModulesIsSymlink: boolean | null = null;
  let observedBaselineCoreRealpath: string | null = null;
  let observedBaselineRootRealpath: string | null = null;
  let observedBaselineLocalCacheRealpath: string | null = null;
  let observedBranchLocalCacheRealpath: string | null = null;
  let observedBranchLocalCacheHasSeed = false;
  let observedBaselineLocalCacheHasSeed = false;
  let mainLocalCacheRealpath: string | null = null;

  function ensureRepoFixture(root: string): void {
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    mkdirSync(join(root, "packages", "config"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
    );
    writeFileSync(join(root, "bun.lock"), "");
  }

  function materializeNodeModules(root: string, contaminateConfig = false): void {
    mkdirSync(join(root, "node_modules", "@penumbra"), { recursive: true });
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    mkdirSync(join(root, "packages", "config"), { recursive: true });
    const coreLink = join(root, "node_modules", "@penumbra", "core");
    const configLink = join(root, "node_modules", "@penumbra", "config");
    rmSync(coreLink, { recursive: true, force: true });
    rmSync(configLink, { recursive: true, force: true });
    symlinkSync(join(root, "packages", "core"), coreLink, "dir");
    symlinkSync(
      contaminateConfig
        ? join(mainRepoDir, "packages", "config")
        : join(root, "packages", "config"),
      configLink,
      "dir",
    );
  }

  try {
    ensureRepoFixture(mainRepoDir);
    ensureRepoFixture(branchRoot);
    materializeNodeModules(mainRepoDir);
    materializeNodeModules(branchRoot);
    if (opts.createLocalCache) {
      mkdirSync(join(mainRepoDir, "local_cache"), { recursive: true });
      writeFileSync(join(mainRepoDir, "local_cache", "fastembed.bin"), "cache");
      mainLocalCacheRealpath = realpathSync(join(mainRepoDir, "local_cache"));
    }

    getWorktreeSpy.mockImplementationOnce((handoffId: string) => ({
      handoffId,
      path: branchRoot,
      branchName: `agent/${handoffId}`,
      storageRoot: join(branchRoot, ".test-storage"),
      createdAt: "",
      status: "created" as const,
      worktreeMode: "isolated_install" as const,
    }));

    // eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the fixture command dispatcher while grandfathering its pre-existing complexity.
    const exec = (argv: string[], execOpts: { cwd: string }): Promise<ExecResult> => {
      const cmd = argv.join(" ");
      execCalls.push({ cmd, cwd: execOpts.cwd });
      if (cmd === "git rev-parse HEAD") {
        return Promise.resolve({ stdout: `${defaultBranchHeadSha}\n`, stderr: "" });
      }
      if (cmd === "git rev-parse main") {
        return Promise.resolve({ stdout: `${defaultBaseTipSha}\n`, stderr: "" });
      }
      if (cmd === `git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`) {
        return Promise.resolve({ stdout: `${opts.mergeBaseSha}\n`, stderr: "" });
      }
      if (cmd.startsWith("git diff --name-only")) {
        return Promise.resolve({ stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" });
      }
      if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
        return Promise.resolve(defaultShortStat);
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
        if (worktreePath) ensureRepoFixture(worktreePath);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (cmd === "bun tsc -b packages/core packages/daemon") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (cmd === "bun install --ignore-scripts --frozen-lockfile") {
        if (opts.failBaselineInstall && execOpts.cwd === baselineScratchPath) {
          return Promise.reject(new ExecCommandError({ stderr: "lockfile had changes", code: 1 }));
        }
        materializeNodeModules(
          execOpts.cwd,
          Boolean(opts.contaminateBaselineConfigLink && execOpts.cwd === baselineScratchPath),
        );
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (cmd === "bun test packages/daemon/test/") {
        const branchLocalCache = join(branchRoot, "local_cache");
        if (execOpts.cwd === branchRoot && existsSync(branchLocalCache)) {
          observedBranchLocalCacheRealpath = realpathSync(branchLocalCache);
          observedBranchLocalCacheHasSeed = existsSync(join(branchLocalCache, "fastembed.bin"));
        }
        if (execOpts.cwd === baselineScratchPath) {
          const baselineNodeModules = join(execOpts.cwd, "node_modules");
          if (existsSync(baselineNodeModules)) {
            observedBaselineNodeModulesIsSymlink = lstatSync(baselineNodeModules).isSymbolicLink();
          }
          const baselineCore = join(baselineNodeModules, "@penumbra", "core");
          if (existsSync(baselineCore)) {
            observedBaselineCoreRealpath = realpathSync(baselineCore);
          }
          observedBaselineRootRealpath = realpathSync(execOpts.cwd);
          const baselineLocalCache = join(execOpts.cwd, "local_cache");
          if (existsSync(baselineLocalCache)) {
            observedBaselineLocalCacheRealpath = realpathSync(baselineLocalCache);
            observedBaselineLocalCacheHasSeed = existsSync(
              join(baselineLocalCache, "fastembed.bin"),
            );
          }
          const baselineOutput = opts.baselineOutput ?? baselineFailOutput();
          return Promise.reject(new ExecCommandError({ stdout: baselineOutput, code: 1 }));
        }
        return Promise.reject(
          new ExecCommandError({ stdout: opts.branchOutput ?? baselineFailOutput(), code: 1 }),
        );
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const reconciler = createMergeReconciler({
      ...mockDeps,
      mainRepoDir,
      rebaseScratchRoot: scratchRoot,
      exec,
    });

    const result = await reconciler(opts.handoffId);
    return {
      result,
      execCalls,
      observedBaselineNodeModulesIsSymlink,
      observedBaselineCoreRealpath,
      observedBaselineRootRealpath,
      observedBaselineLocalCacheRealpath,
      observedBranchLocalCacheRealpath,
      observedBranchLocalCacheHasSeed,
      observedBaselineLocalCacheHasSeed,
      mainLocalCacheRealpath,
      baselineScratchPath,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("baseline test environment provisioning", () => {
  test("baseline scratch owns its node_modules", async () => {
    const scenario = await runBaselineProvisioningScenario({
      handoffId: "h-baseline-owns-node-modules",
      mergeBaseSha: "1".repeat(40),
    });

    expect(scenario.observedBaselineNodeModulesIsSymlink).toBe(false);
    expect(
      scenario.observedBaselineCoreRealpath?.startsWith(
        scenario.observedBaselineRootRealpath ?? "",
      ),
    ).toBe(true);
  });

  test("baseline installs from the merge-base lockfile", async () => {
    const scenario = await runBaselineProvisioningScenario({
      handoffId: "h-baseline-frozen-install",
      mergeBaseSha: "2".repeat(40),
    });

    expect(scenario.execCalls).toContainEqual({
      cmd: "bun install --ignore-scripts --frozen-lockfile",
      cwd: scenario.baselineScratchPath,
    });
  });

  test("contaminated baseline environment fails closed", async () => {
    const scenario = await runBaselineProvisioningScenario({
      handoffId: "h-baseline-contaminated-env",
      mergeBaseSha: "3".repeat(40),
      branchOutput: baselineFailOutput("daemon changed suite > newly fails"),
      baselineOutput: baselinePassOutput(),
      contaminateBaselineConfigLink: true,
    });

    expect(scenario.result.status).toBe("test_failed");
    expect(scenario.result.verification_environment_error).toBe(true);
    expect(scenario.result.regression_summary).toContain("verification environment error (tests)");
    expect(scenario.result.regression_summary).toContain("@penumbra/config");
    expect(scenario.result.regression_summary).not.toContain("new test failures");
  });

  test("baseline install failure fails closed", async () => {
    const scenario = await runBaselineProvisioningScenario({
      handoffId: "h-baseline-install-error",
      mergeBaseSha: "4".repeat(40),
      branchOutput: baselineFailOutput("daemon changed suite > newly fails"),
      failBaselineInstall: true,
    });

    expect(scenario.result.status).toBe("test_failed");
    expect(scenario.result.verification_environment_error).toBe(true);
    expect(scenario.result.regression_summary).toContain("verification environment error (tests)");
    expect(scenario.result.regression_summary).toContain("lockfile had changes");
    expect(scenario.result.regression_summary).not.toContain("new test failures");
  });

  test("local_cache is provisioned into branch and baseline test environments", async () => {
    const scenario = await runBaselineProvisioningScenario({
      handoffId: "h-baseline-fastembed-cache",
      mergeBaseSha: "5".repeat(40),
      createLocalCache: true,
    });

    expect(scenario.observedBranchLocalCacheRealpath).not.toBe(scenario.mainLocalCacheRealpath);
    expect(scenario.observedBaselineLocalCacheRealpath).not.toBe(scenario.mainLocalCacheRealpath);
    expect(scenario.observedBranchLocalCacheHasSeed).toBe(true);
    expect(scenario.observedBaselineLocalCacheHasSeed).toBe(true);
  });
});

test("PR creation failure returns pr_creation_failed", async () => {
  handoffRows.set(
    "h4",
    makeHandoffRow({
      handoff_id: "h4",
      conversation_id: "c-999",
      message: "failing PR flow",
      open_pr_on_review: true,
    }),
  );
  createDispatchPRFailOnCall = 1;

  const result = await reconcile("h4");

  expect(result.status).toBe("pr_creation_failed");
  expect(result.regression_summary).toContain("Boom");
  expect(progressCalls).toContainEqual({
    id: "h4",
    payload: {
      type: "merge-result",
      handoff_id: "h4",
      status: "pr_creation_failed",
      regression_summary: "Error: Boom",
    },
  });
  expect(notifyResultMock).toHaveBeenCalledWith("h4", {
    status: "pr_creation_failed",
    regression_summary: "Error: Boom",
    progressReported: true,
  });
});

test("Empty branch diff returns no_changes and skips PR creation", async () => {
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);

    if (cmd.startsWith("git diff --name-only")) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }

    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return Promise.reject(new Error("shortstat should not run for empty branches"));
    }

    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_empty");

  expect(result.status).toBe("no_changes");
  expect(execHistory.find((cmd) => cmd.startsWith("bun tsc -b"))).toBeUndefined();
  expect(execHistory.find((cmd) => cmd.startsWith("bun test"))).toBeUndefined();
  expect(execHistory).toContain(
    `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`,
  );
  expect(prCalls).toHaveLength(0);
  expect(progressCalls).toContainEqual({
    id: "h_empty",
    payload: {
      type: "merge-result",
      handoff_id: "h_empty",
      status: "no_changes",
    },
  });
  expect(notifyResultMock).toHaveBeenCalledWith("h_empty", {
    status: "no_changes",
    progressReported: true,
  });
});

describe("branch_base diff scoping", () => {
  function setHandoffBranchBase(handoffId: string, branchBase: string | null): void {
    handoffRows.set(
      handoffId,
      makeHandoffRow({
        handoff_id: handoffId,
        conversation_id: "c-branch-base",
        message: "branch base test",
        branch_base: branchBase,
      }),
    );
  }

  test("uses main when branch_base is null", async () => {
    setHandoffBranchBase("h_branch_null", null);

    await reconcile("h_branch_null");

    expect(execHistory).toContain("git rev-parse main");
    expect(execHistory).toContain(`git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`);
    expect(execHistory).toContain(
      `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`,
    );
  });

  test("uses main when branch_base is main", async () => {
    setHandoffBranchBase("h_branch_main", "main");

    await reconcile("h_branch_main");

    expect(execHistory).toContain("git rev-parse main");
    expect(execHistory).toContain(`git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`);
    expect(execHistory).toContain(
      `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`,
    );
  });

  test("uses agent branch_base when present", async () => {
    setHandoffBranchBase("h_branch_agent", "agent/abc-123");

    await reconcile("h_branch_agent");

    expect(execHistory).toContain("git rev-parse agent/abc-123");
    expect(execHistory).toContain(`git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`);
    expect(execHistory).toContain(
      `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`,
    );
  });

  test("uses stage branch_base when present", async () => {
    setHandoffBranchBase("h_branch_stage", "stage/plan__1.3");

    await reconcile("h_branch_stage");

    expect(execHistory).toContain("git rev-parse stage/plan__1.3");
    expect(execHistory).toContain(`git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`);
    expect(execHistory).toContain(
      `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`,
    );
  });

  test("non-main branch_base threads through no-changes gate, shortstat, and verdict", async () => {
    setHandoffBranchBase("h_branch_full_scope", "stage/plan__2.7");

    await reconcile("h_branch_full_scope");

    const scopedDiff = `git diff --name-only ${defaultMergeBaseSha}...${defaultBranchHeadSha}`;
    expect(execHistory.filter((c) => c === scopedDiff).length).toBeGreaterThanOrEqual(2);
    expect(execHistory).toContain(
      `git diff ${defaultMergeBaseSha}...${defaultBranchHeadSha} --shortstat`,
    );
    expect(execHistory).toContain("git rev-parse stage/plan__2.7");
    expect(execHistory).toContain(`git merge-base ${defaultBaseTipSha} ${defaultBranchHeadSha}`);
    expect(execHistory).toContain(
      `git merge-base --is-ancestor ${defaultBaseTipSha} ${defaultBranchHeadSha}`,
    );
    expect(execHistory.some((c) => c === "git rev-parse main")).toBe(false);
    expect(execHistory.some((c) => c.startsWith("git merge-base --is-ancestor main "))).toBe(false);
    expect(execHistory.some((c) => c.includes("main...agent/h_branch_full_scope"))).toBe(false);
  });

  test.each([
    "--exec=evil",
    "main; rm -rf /",
    "main\nother",
    `main${String.fromCharCode(0)}evil`,
    "-main",
  ])("rejects invalid branch_base value: %p", async (invalidBranchBase) => {
    setHandoffBranchBase("h_branch_invalid", invalidBranchBase);

    const result = await reconcile("h_branch_invalid");

    expect(result.status).toBe("test_failed");
    expect(result.error_code).toBe("invalid_branch_base");
    expect(execHistory).toEqual([]);
  });
});

test("Parallel reconciles are serialized by the lock", async () => {
  handoffRows.set(
    "h6",
    makeHandoffRow({
      handoff_id: "h6",
      conversation_id: "c-h6",
      message: "h6",
      open_pr_on_review: true,
    }),
  );
  handoffRows.set(
    "h7",
    makeHandoffRow({
      handoff_id: "h7",
      conversation_id: "c-h7",
      message: "h7",
      open_pr_on_review: true,
    }),
  );
  let activePRs = 0;
  let maxConcurrency = 0;
  createDispatchPRMock.mockImplementation(
    async (args: CreatePRArgs, _log: Logger): Promise<CreatePRResult> => {
      prCalls.push({ args });
      activePRs += 1;
      maxConcurrency = Math.max(maxConcurrency, activePRs);
      await new Promise((resolve) => setTimeout(resolve, 50));
      activePRs -= 1;
      return {
        url: "https://github.com/frozename/penumbra/pull/321",
        number: 321,
      };
    },
  );

  const p1 = reconcile("h6");
  const p2 = reconcile("h7");

  await Promise.all([p1, p2]);

  expect(maxConcurrency).toBe(1);
});

test("Mutex isolation: subsequent PR flows run even if previous one throws", async () => {
  handoffRows.set(
    "h_mutex_1",
    makeHandoffRow({
      handoff_id: "h_mutex_1",
      conversation_id: "c-m1",
      message: "m1",
      open_pr_on_review: true,
    }),
  );
  handoffRows.set(
    "h_mutex_2",
    makeHandoffRow({
      handoff_id: "h_mutex_2",
      conversation_id: "c-m2",
      message: "m2",
      open_pr_on_review: true,
    }),
  );
  let callCount = 0;
  createDispatchPRMock.mockImplementation(
    (_args: CreatePRArgs, _log: Logger): Promise<CreatePRResult> => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error("Boom"));
      }
      return Promise.resolve({
        url: "https://github.com/frozename/penumbra/pull/321",
        number: 321,
      });
    },
  );

  const p1 = reconcile("h_mutex_1");
  const p2 = reconcile("h_mutex_2");

  const [r1, r2] = await Promise.all([p1, p2]);
  expect([r1.status, r2.status].sort()).toEqual(["pr_creation_failed", "pr_opened"]);
});

test("Typecheck timeout returns timed_out: true", async () => {
  mockDeps.settings = {
    reconcileTypecheckTimeoutSec: 0.1,
    reconcileTestTimeoutSec: 300,
  };
  execMock.mockImplementation(async (argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }
    if (cmd.includes("bun tsc -b packages/core packages/daemon")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_timeout_1");
  expect(result.status).toBe("typecheck_failed");
  expect(result.timed_out).toBe(true);
});

test("Test timeout returns timed_out: true", async () => {
  mockDeps.settings = {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 0.1,
  };
  execMock.mockImplementation(async (argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }
    if (cmd.includes("bun test")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_timeout_2");
  expect(result.status).toBe("test_failed");
  expect(result.timed_out).toBe(true);
});

test("merge-base probe exit 128 is treated as error, not 'rebase needed'", async () => {
  execMock.mockImplementation((argv: string[]): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) return Promise.resolve(defaultDiffResult);
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat"))
      return Promise.resolve(defaultShortStat);
    if (cmd.startsWith("git merge-base --is-ancestor")) {
      return Promise.reject(new ExecCommandError({ stderr: "fatal: bad revision", code: 128 }));
    }
    return defaultExecForCommand(cmd);
  });

  const result = await reconcile("h_probe_err");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.includes("git worktree add --detach"))).toBe(false);
  expect(execHistory.some((cmd) => cmd === "git rebase main")).toBe(false);

  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h_probe_err",
    ff_mergeable: false,
    rebase_required: false,
    rebase_attempted: false,
    rebase_result: "skipped",
  });

  expect(logMocks.warn).toHaveBeenCalledWith(
    expect.objectContaining({ exitCode: 128 }),
    expect.stringMatching(/merge-base is-ancestor probe failed/),
  );
  expect(logMocks.warn).toHaveBeenCalledWith(
    expect.objectContaining({ exitCode: 128 }),
    expect.stringMatching(/verdict merge-base probe errored/),
  );
});

describe("resolveAffectedPackages", () => {
  test("resolveAffectedPackages returns single package for one daemon path", () => {
    const result = resolveAffectedPackages(["packages/daemon/src/routes/handoffs.ts"]);
    expect(result).toEqual(["packages/daemon"]);
  });

  test("resolveAffectedPackages returns multiple distinct packages, deduplicated", () => {
    const result = resolveAffectedPackages([
      "packages/daemon/src/routes/handoffs.ts",
      "packages/mcp/src/tools/chain-status.ts",
      "packages/daemon/test/routes/handoffs-status.test.ts",
    ]);
    expect(result?.sort()).toEqual(["packages/daemon", "packages/mcp"]);
  });

  test("resolveAffectedPackages returns null when a non-package path is touched", () => {
    const result = resolveAffectedPackages([
      "packages/daemon/src/routes/handoffs.ts",
      "tsconfig.base.json",
    ]);
    expect(result).toBeNull();
  });

  test("resolveAffectedPackages returns null when bun.lock or root package.json is touched", () => {
    expect(resolveAffectedPackages(["bun.lock"])).toBeNull();
    expect(resolveAffectedPackages(["package.json"])).toBeNull();
  });

  test("resolveAffectedPackages returns empty array for docs-only changes", () => {
    const result = resolveAffectedPackages([
      "docs/superpowers/plans/some-plan.md",
      "docs/notes/some-note.md",
    ]);
    expect(result).toEqual([]);
  });

  test("resolveAffectedPackages returns empty array for empty diff", () => {
    expect(resolveAffectedPackages([])).toEqual([]);
  });

  test("resolveAffectedPackages scopes package.json inside a package root", () => {
    const result = resolveAffectedPackages(["packages/daemon/package.json"]);
    expect(result).toEqual(["packages/daemon"]);
  });

  test("resolveAffectedPackages maps nested workspace group paths to the real package root", () => {
    const isPackageDir = (dir: string): boolean =>
      dir === "packages/core" || dir === "packages/integrations/typesafe";
    expect(
      resolveAffectedPackages(["packages/integrations/typesafe/src/client.ts"], isPackageDir),
    ).toEqual(["packages/integrations/typesafe"]);
    expect(resolveAffectedPackages(["packages/core/src/x.ts"], isPackageDir)).toEqual([
      "packages/core",
    ]);
  });

  test("resolveAffectedPackages keeps scripts/ and test/ root paths out of the fallback", () => {
    const isPackageDir = (dir: string): boolean => dir === "packages/daemon";
    expect(
      resolveAffectedPackages(["scripts/foo.ts", "scripts/foo.test.ts"], isPackageDir),
    ).toEqual([]);
    expect(
      resolveAffectedPackages(
        ["test/fixtures/x.test.ts", "packages/daemon/src/x.ts"],
        isPackageDir,
      ),
    ).toEqual(["packages/daemon"]);
  });
});

function makeScopedReconciler(
  exec: (argv: string[], opts: { cwd: string }) => Promise<ExecResult>,
): ReturnType<typeof createMergeReconciler> {
  const execWithSnapshotDefaults = (argv: string[], opts: { cwd: string }): Promise<ExecResult> => {
    const cmd = argv.join(" ");
    if (
      cmd === "git rev-parse HEAD" ||
      cmd.startsWith("git rev-parse ") ||
      (cmd.startsWith("git merge-base ") && !cmd.startsWith("git merge-base --is-ancestor"))
    ) {
      return defaultExecForCommand(cmd);
    }
    return exec(argv, opts);
  };
  return createMergeReconciler({
    worktreeManager: new WorktreeManager(),
    postProgress: mock(() => Promise.resolve()),
    log: makeTestLogger(),
    mainRepoDir: "/repo",
    getHandoff: mock(() => Promise.resolve<HandoffRow | null>(null)),
    createDispatchPR: mock(() =>
      Promise.resolve({
        url: "https://github.com/frozename/penumbra/pull/999",
        number: 999,
      }),
    ),
    exec: execWithSnapshotDefaults,
  });
}

describe("reconciler test step is diff-scoped", () => {
  test("runs bun test packages/daemon/test/ when only daemon changed", async () => {
    const execCalls: string[] = [];
    const exec = (argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return Promise.resolve({ stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler("diff-scoped-1");

    expect(execCalls.find((cmd) => cmd.startsWith("bun test"))).toBe(
      "bun test packages/daemon/test/",
    );
  });

  test("skips test step entirely when diff is docs-only", async () => {
    const execCalls: string[] = [];
    const exec = (argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return Promise.resolve({ stdout: "docs/plans/foo.md\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler("diff-scoped-2");

    expect(execCalls.find((cmd) => cmd.startsWith("bun test"))).toBeUndefined();
  });

  test("falls back to full bun test when a root file changed", async () => {
    const execCalls: string[] = [];
    const exec = (argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return Promise.resolve({
          stdout: "packages/daemon/src/foo.ts\nbun.lock\n",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler("diff-scoped-3");

    expect(execCalls).toContain("bun test");
  });

  test.each([
    "packages/evil;rm/src/file.ts",
    "packages/bad name/src/file.ts",
    "packages/../escape/src/file.ts",
    "packages/-evil/src/file.ts",
  ])("rejects invalid scoped test package path from diff: %p", async (maliciousPath) => {
    const execCalls: string[] = [];
    const exec = (argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return Promise.resolve({ stdout: `${maliciousPath}\n`, stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const reconciler = makeScopedReconciler(exec);
    const result = await reconciler("diff-scoped-invalid");

    expect(result.status).toBe("test_failed");
    expect(result.error_code).toBe("invalid_test_package_path");
    expect(execCalls.some((cmd) => cmd.startsWith("bun test"))).toBe(false);
  });
});
