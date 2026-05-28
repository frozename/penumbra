import { expect, test, mock, spyOn, beforeEach, describe } from "bun:test";
import {
  createMergeReconciler,
  resolveAffectedPackages,
} from "../../src/worker/merge-reconciler.js";
import { WorktreeManager } from "@penumbra/core";
import type { RuntimeThoughtsConfig } from "../../src/worker/thought-config.js";

const mockLog: any = {
  info: mock(() => {}),
  debug: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

const progressCalls: any[] = [];
const verdictCalls: any[] = [];
const execHistory: string[] = [];
const prCalls: any[] = [];
const handoffRows: Record<string, any> = {};
let nextExecResult: any = { stdout: "", stderr: "" };
let execFailures: Record<string, any> = {};
let createDispatchPRFailOnCall: number | null = null;
let createDispatchPRCallCount = 0;
let createDispatchPRDelayMs = 0;
const defaultDiffResult = { stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" };
const defaultShortStat = {
  stdout: " 1 file changed, 2 insertions(+), 1 deletion(-)\n",
  stderr: "",
};

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async (id: string, payload: any) => {
    progressCalls.push({ id, payload });
  }),
  notifyResult: mock(async () => {}),
  captureResult: mock(async () => {}),
  emitVerdict: mock(async (verdict: any) => {
    verdictCalls.push(verdict);
  }),
  log: mockLog,
  mainRepoDir: "/main/repo",
  getHandoff: mock(async (id: string) => {
    return handoffRows[id] ?? null;
  }),
  createDispatchPR: mock(async (args: any) => {
    createDispatchPRCallCount += 1;
    prCalls.push(args);
    if (createDispatchPRDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, createDispatchPRDelayMs));
    }
    if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
      throw new Error("Boom");
    }
    return {
      url: "https://github.com/acordeiro/penumbra/pull/321",
      number: 321,
    };
  }),
  exec: mock(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);

    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }

    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return defaultShortStat;
    }

    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) {
        throw error;
      }
    }

    return nextExecResult;
  }),
  rebaseScratchRoot: "/tmp/penumbra-rebase-scratch",
  settings: {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  },
};

spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation((id: string) => {
  if (id === "missing") return null;
  return {
    handoffId: id,
    path: `/worktree/${id}`,
    branchName: `agent/${id}`,
    storageRoot: `/worktree/${id}/.test-storage`,
    createdAt: "",
    status: "created",
  } as any;
});

beforeEach(() => {
  progressCalls.length = 0;
  verdictCalls.length = 0;
  execHistory.length = 0;
  prCalls.length = 0;
  createDispatchPRCallCount = 0;
  createDispatchPRDelayMs = 0;
  createDispatchPRFailOnCall = null;
  nextExecResult = { stdout: "", stderr: "" };
  execFailures = {};
  for (const key of Object.keys(handoffRows)) {
    delete handoffRows[key];
  }
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);

    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }

    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      return defaultShortStat;
    }

    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }

    return nextExecResult;
  });
  mockDeps.createDispatchPR.mockImplementation(async (args: any) => {
    createDispatchPRCallCount += 1;
    prCalls.push(args);
    if (createDispatchPRDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, createDispatchPRDelayMs));
    }
    if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
      throw new Error("Boom");
    }
    return {
      url: "https://github.com/acordeiro/penumbra/pull/321",
      number: 321,
    };
  });
  mockDeps.getHandoff.mockImplementation(async (id: string) => {
    return handoffRows[id] ?? null;
  });
  mockDeps.notifyResult.mockReset();
  mockDeps.notifyResult.mockImplementation(async () => {});
  mockDeps.captureResult.mockReset();
  mockDeps.captureResult.mockImplementation(async () => {});
  mockDeps.emitVerdict.mockReset();
  mockDeps.emitVerdict.mockImplementation(async (verdict: any) => {
    verdictCalls.push(verdict);
  });
  delete mockDeps.thoughtsConfig;
  delete mockDeps.thoughtAnalyzerDeps;
  delete mockDeps.runThoughtAnalyzer;
  delete mockDeps.listThoughtEvents;
  delete mockDeps.getParentHandoffId;
  mockDeps.settings = {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  };
});

const reconcile = createMergeReconciler(mockDeps);

function thoughtsConfigEnabled(onlyWhen: string[] = ["pr_opened"]): RuntimeThoughtsConfig {
  return {
    enabled: true,
    capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
    analyze: {
      enabled: true,
      onlyWhen,
      digest: { enabled: true, agent: "local-gemma26", maxInputChars: 1000, timeoutMs: 5000 },
      signals: {
        enabled: false,
        agent: "local-gemma26",
        timeoutMs: 5000,
        maxInputChars: null,
        definitions: [],
      },
    },
  };
}

test("default reconcile verifies and emits verdict without opening PR", async () => {
  handoffRows.h1 = {
    handoff_id: "h1",
    ts: "2026-04-28T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-456",
    from_agent: "user",
    to_agent: "codex-mini",
    to_role: null,
    message: "dispatch prompt with $(touch /tmp/pwned) literally",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    open_pr_on_review: 0,
  } as any;

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(result.pr_url).toBeUndefined();
  expect(result.pr_number).toBeUndefined();
  expect(execHistory).toContain("bun tsc -b packages/core packages/daemon");
  expect(execHistory).toContain("bun test packages/daemon/test/");
  expect(execHistory).toContain("git diff main...agent/h1 --shortstat");
  expect(prCalls).toHaveLength(0);
  expect(mockLog.info).toHaveBeenCalledWith(
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
  expect(mockDeps.notifyResult).toHaveBeenCalledWith("h1", {
    status: "verified",
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
    ff_mergeable: expect.any(Boolean),
    rebase_required: expect.any(Boolean),
    rebase_attempted: false,
    rebase_result: "skipped",
    pr_url: null,
    duration_ms: expect.any(Number),
    summary: expect.any(String),
  });
  expect(typeof verdictCalls[0].verified_at).toBe("string");
  expect(verdictCalls[0].verified_at).toMatch(/Z$/);
});

test("ff_mergeable=false rebase success emits success verdict with rebased branch", async () => {
  let mergeBaseCalls = 0;
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) return defaultDiffResult;
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) return defaultShortStat;
    if (cmd === "git merge-base --is-ancestor main agent/h_rebase_ok") {
      mergeBaseCalls += 1;
      if (mergeBaseCalls === 1) throw { stderr: "not-ancestor" };
      return { stdout: "", stderr: "" };
    }
    if (cmd === "git rev-parse agent/h_rebase_ok") {
      return { stdout: "rebased-sha\n", stderr: "" };
    }
    return nextExecResult;
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
  expect(execHistory).toEqual(
    expect.arrayContaining([
      "git worktree remove --force /tmp/penumbra-rebase-scratch/h_rebase_ok",
      "git worktree add --detach /tmp/penumbra-rebase-scratch/h_rebase_ok main",
      "git checkout agent/h_rebase_ok",
      "git rebase main",
      "git rev-parse agent/h_rebase_ok",
      "git merge-base --is-ancestor main rebased-sha",
      "git push --force-with-lease origin agent/h_rebase_ok:agent/h_rebase_ok",
    ]),
  );
});

test("ff_mergeable=false rebase conflict emits conflict verdict with file list", async () => {
  execFailures["git merge-base --is-ancestor main agent/h_rebase_conflict"] = {
    stderr: "not-ancestor",
  };
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd === "git diff --name-only --diff-filter=U")
      return { stdout: "a.ts\nb.ts\n", stderr: "" };
    if (cmd.startsWith("git diff --name-only")) return defaultDiffResult;
    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) return defaultShortStat;
    if (cmd === "git rebase main") throw { stderr: "CONFLICT" };
    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }
    return nextExecResult;
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
  expect(execHistory).toEqual(
    expect.arrayContaining([
      "git worktree remove --force /tmp/penumbra-rebase-scratch/h_rebase_conflict",
      "git worktree add --detach /tmp/penumbra-rebase-scratch/h_rebase_conflict main",
      "git checkout agent/h_rebase_conflict",
      "git rebase main",
      "git diff --name-only --diff-filter=U",
      "git rebase --abort",
    ]),
  );
});

test("reconcilerAutoRebase=false skips rebase even when ff_mergeable=false", async () => {
  execFailures["git merge-base --is-ancestor main agent/h_rebase_disabled"] = {
    stderr: "not-ancestor",
  };
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
  handoffRows.h1 = {
    handoff_id: "h1",
    ts: "2026-04-28T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-456",
    from_agent: "user",
    to_agent: "codex-mini",
    to_role: null,
    message: "dispatch prompt with $(touch /tmp/pwned) literally",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    open_pr_on_review: 1,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  } as any;

  const result = await reconcile("h1");
  expect(result.status).toBe("pr_opened");
  expect(prCalls).toHaveLength(1);
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0].pr_url).toBe("https://github.com/acordeiro/penumbra/pull/321");
});

test("reconciler posts successful results to capture dependency", async () => {
  mockDeps.captureResult.mockReset();
  mockDeps.captureResult.mockImplementation(async () => {});
  const result = await reconcile("h1");
  expect(result.status).toBe("verified");
  expect(mockDeps.captureResult).toHaveBeenCalledWith("h1", {
    status: "verified",
  });
});

test("capture dependency failure does not change reconciler result", async () => {
  mockDeps.captureResult.mockReset();
  mockDeps.captureResult.mockImplementation(async () => {
    throw new Error("capture down");
  });
  const result = await reconcile("h1");
  expect(result.status).toBe("verified");
  expect(mockDeps.notifyResult).toHaveBeenCalled();
});

test("runs thought analyzer after notifyResult when merge status is in onlyWhen", async () => {
  const callOrder: string[] = [];
  const thoughtRows = [
    { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
  ];

  mockDeps.notifyResult.mockImplementation(async () => {
    callOrder.push("notifyResult");
  });
  mockDeps.getParentHandoffId = mock(async () => null);
  mockDeps.listThoughtEvents = mock(async () => {
    callOrder.push("listThoughtEvents");
    return thoughtRows;
  });
  mockDeps.runThoughtAnalyzer = mock(async (input: any) => {
    callOrder.push("runThoughtAnalyzer");
    expect(input).toMatchObject({
      handoffId: "h1",
      thoughts: thoughtRows,
      mergeStatus: "verified",
      config: mockDeps.thoughtsConfig,
      deps: mockDeps.thoughtAnalyzerDeps,
    });
  });
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(async () => ({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(async () => ({ status: "completed" })),
    chainResponse: mock(async () => ({ responses: [] })),
    recordEvent: mock(async () => {}),
    log: mockLog,
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.notifyResult).toHaveBeenCalledTimes(1);
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).toHaveBeenCalledWith("h1");
  expect(mockDeps.runThoughtAnalyzer).toHaveBeenCalledTimes(1);
  expect(callOrder).toEqual(["notifyResult", "listThoughtEvents", "runThoughtAnalyzer"]);
});

test("skips the analyzer when merge status is not in onlyWhen", async () => {
  mockDeps.listThoughtEvents = mock(async () => [
    { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
  ]);
  mockDeps.runThoughtAnalyzer = mock(async () => {});
  mockDeps.getParentHandoffId = mock(async () => null);
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["test_failed"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(async () => ({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(async () => ({ status: "completed" })),
    chainResponse: mock(async () => ({ responses: [] })),
    recordEvent: mock(async () => {}),
    log: mockLog,
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).not.toHaveBeenCalled();
  expect(mockDeps.listThoughtEvents).not.toHaveBeenCalled();
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("skips the analyzer when there are no thought events", async () => {
  mockDeps.getParentHandoffId = mock(async () => null);
  mockDeps.listThoughtEvents = mock(async () => []);
  mockDeps.runThoughtAnalyzer = mock(async () => {});
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(async () => ({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(async () => ({ status: "completed" })),
    chainResponse: mock(async () => ({ responses: [] })),
    recordEvent: mock(async () => {}),
    log: mockLog,
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).toHaveBeenCalledWith("h1");
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("skips the analyzer for sub-handoff dispatches (parent_handoff_id non-null)", async () => {
  mockDeps.getParentHandoffId = mock(async () => "parent-123");
  mockDeps.listThoughtEvents = mock(async () => [
    { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
  ]);
  mockDeps.runThoughtAnalyzer = mock(async () => {});
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(async () => ({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(async () => ({ status: "completed" })),
    chainResponse: mock(async () => ({ responses: [] })),
    recordEvent: mock(async () => {}),
    log: mockLog,
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.getParentHandoffId).toHaveBeenCalledWith("h1");
  expect(mockDeps.listThoughtEvents).not.toHaveBeenCalled();
  expect(mockDeps.runThoughtAnalyzer).not.toHaveBeenCalled();
});

test("does not throw when analyzer throws — logs and continues", async () => {
  mockDeps.getParentHandoffId = mock(async () => null);
  mockDeps.listThoughtEvents = mock(async () => [
    { sequence_n: 1, adapter: "stdio-acp", agent_name: "claude", text: "consider option A" },
  ]);
  mockDeps.runThoughtAnalyzer = mock(async () => {
    throw new Error("analyzer blew up");
  });
  mockDeps.thoughtsConfig = thoughtsConfigEnabled(["verified"]);
  mockDeps.thoughtAnalyzerDeps = {
    chainStart: mock(async () => ({ conversation_id: "c", handoff_id: "h" })),
    chainWait: mock(async () => ({ status: "completed" })),
    chainResponse: mock(async () => ({ responses: [] })),
    recordEvent: mock(async () => {}),
    log: mockLog,
  };

  const result = await reconcile("h1");

  expect(result.status).toBe("verified");
  expect(mockDeps.runThoughtAnalyzer).toHaveBeenCalledTimes(1);
  expect(mockLog.warn).toHaveBeenCalledWith(
    { handoffId: "h1", err: "Error: analyzer blew up" },
    "thought analyzer failed",
  );
});

test("Typecheck fail: returns typecheck_failed and skips PR creation", async () => {
  execFailures["bun tsc -b packages/core packages/daemon"] = { stderr: "Syntax error" };

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
  expect(mockDeps.notifyResult).toHaveBeenCalledWith("h2", {
    status: "typecheck_failed",
    regression_summary: "packages/core, packages/daemon: Syntax error",
  });
  expect(verdictCalls).toHaveLength(1);
  expect(verdictCalls[0]).toMatchObject({
    handoff_id: "h2",
    typecheck: "fail",
    tests: "skipped",
    pr_url: null,
  });
});

test("Test fail: returns test_failed and skips PR creation", async () => {
  execFailures["bun test"] = { stderr: "1 test failed" };

  const result = await reconcile("h3");

  expect(result.status).toBe("test_failed");
  expect(result.regression_summary).toBe("1 test failed");
  expect(execHistory).toContain("bun tsc -b packages/core packages/daemon");
  expect(execHistory).toContain("bun test packages/daemon/test/");
  expect(prCalls).toHaveLength(0);
  expect(mockDeps.notifyResult).toHaveBeenCalledWith("h3", {
    status: "test_failed",
    regression_summary: "1 test failed",
  });
});

test("PR creation failure returns pr_creation_failed", async () => {
  handoffRows.h4 = {
    handoff_id: "h4",
    ts: "2026-04-28T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-999",
    from_agent: "user",
    to_agent: "codex-mini",
    to_role: null,
    message: "failing PR flow",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    open_pr_on_review: 1,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  } as any;
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
  expect(mockDeps.notifyResult).toHaveBeenCalledWith("h4", {
    status: "pr_creation_failed",
    regression_summary: "Error: Boom",
  });
});

test("Empty branch diff returns no_changes and skips PR creation", async () => {
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);

    if (cmd.startsWith("git diff --name-only")) {
      return { stdout: "", stderr: "" };
    }

    if (cmd.startsWith("git diff") && cmd.includes("--shortstat")) {
      throw new Error("shortstat should not run for empty branches");
    }

    return nextExecResult;
  });

  const result = await reconcile("h_empty");

  expect(result.status).toBe("no_changes");
  expect(execHistory.find((cmd) => cmd.startsWith("bun tsc -b"))).toBeUndefined();
  expect(execHistory.find((cmd) => cmd.startsWith("bun test"))).toBeUndefined();
  expect(execHistory).toContain("git diff --name-only main..agent/h_empty");
  expect(execHistory).toContain("git diff --name-only main...agent/h_empty");
  expect(prCalls).toHaveLength(0);
  expect(progressCalls).toContainEqual({
    id: "h_empty",
    payload: {
      type: "merge-result",
      handoff_id: "h_empty",
      status: "no_changes",
    },
  });
  expect(mockDeps.notifyResult).toHaveBeenCalledWith("h_empty", {
    status: "no_changes",
  });
});

describe("branch_base diff scoping", () => {
  function setHandoffBranchBase(handoffId: string, branchBase: string | null) {
    handoffRows[handoffId] = {
      handoff_id: handoffId,
      ts: "2026-04-28T00:00:00.000Z",
      project_id: null,
      conversation_id: "c-branch-base",
      from_agent: "user",
      to_agent: "codex-mini",
      to_role: null,
      message: "branch base test",
      status: "completed",
      resolved_by: null,
      resolved_at: null,
      redirected_to: null,
      resolution_reason: null,
      triggered_by_event_id: null,
      chain_max_hops: null,
      chain_trust_mode: null,
      use_worktree: null,
      error_message: null,
      cancel_requested_at: null,
      worker_id: null,
      parent_handoff_id: null,
      branch_base: branchBase,
    } as any;
  }

  test("uses main when branch_base is null", async () => {
    setHandoffBranchBase("h_branch_null", null);

    await reconcile("h_branch_null");

    expect(execHistory).toContain("git diff --name-only main..agent/h_branch_null");
  });

  test("uses main when branch_base is main", async () => {
    setHandoffBranchBase("h_branch_main", "main");

    await reconcile("h_branch_main");

    expect(execHistory).toContain("git diff --name-only main..agent/h_branch_main");
  });

  test("uses agent branch_base when present", async () => {
    setHandoffBranchBase("h_branch_agent", "agent/abc-123");

    await reconcile("h_branch_agent");

    expect(execHistory).toContain("git diff --name-only agent/abc-123..agent/h_branch_agent");
  });

  test("uses stage branch_base when present", async () => {
    setHandoffBranchBase("h_branch_stage", "stage/plan__1.3");

    await reconcile("h_branch_stage");

    expect(execHistory).toContain("git diff --name-only stage/plan__1.3..agent/h_branch_stage");
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
  handoffRows.h6 = {
    handoff_id: "h6",
    conversation_id: "c-h6",
    to_agent: "codex-mini",
    message: "h6",
    open_pr_on_review: 1,
  } as any;
  handoffRows.h7 = {
    handoff_id: "h7",
    conversation_id: "c-h7",
    to_agent: "codex-mini",
    message: "h7",
    open_pr_on_review: 1,
  } as any;
  let activePRs = 0;
  let maxConcurrency = 0;
  mockDeps.createDispatchPR.mockImplementation(async (args: any) => {
    prCalls.push(args);
    activePRs += 1;
    maxConcurrency = Math.max(maxConcurrency, activePRs);
    await new Promise((resolve) => setTimeout(resolve, 50));
    activePRs -= 1;
    return {
      url: "https://github.com/acordeiro/penumbra/pull/321",
      number: 321,
    };
  });

  const p1 = reconcile("h6");
  const p2 = reconcile("h7");

  await Promise.all([p1, p2]);

  expect(maxConcurrency).toBe(1);
});

test("Mutex isolation: subsequent PR flows run even if previous one throws", async () => {
  handoffRows.h_mutex_1 = {
    handoff_id: "h_mutex_1",
    conversation_id: "c-m1",
    to_agent: "codex-mini",
    message: "m1",
    open_pr_on_review: 1,
  } as any;
  handoffRows.h_mutex_2 = {
    handoff_id: "h_mutex_2",
    conversation_id: "c-m2",
    to_agent: "codex-mini",
    message: "m2",
    open_pr_on_review: 1,
  } as any;
  let callCount = 0;
  mockDeps.createDispatchPR.mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("Boom");
    }
    return {
      url: "https://github.com/acordeiro/penumbra/pull/321",
      number: 321,
    };
  });

  const p1 = reconcile("h_mutex_1");
  const p2 = reconcile("h_mutex_2");

  const [r1, r2] = await Promise.all([p1, p2]);
  expect((r1 as any).status).toBe("pr_creation_failed");
  expect((r2 as any).status).toBe("pr_opened");
});

test("Typecheck timeout returns timed_out: true", async () => {
  mockDeps.settings.reconcileTypecheckTimeoutSec = 0.1;
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }
    if (cmd.includes("bun tsc -b packages/core packages/daemon")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { stdout: "", stderr: "" };
  });

  const result = await reconcile("h_timeout_1");
  expect(result.status).toBe("typecheck_failed");
  expect(result.timed_out).toBe(true);
});

test("Test timeout returns timed_out: true", async () => {
  mockDeps.settings.reconcileTestTimeoutSec = 0.1;
  mockDeps.exec.mockImplementation(async (argv: string[]) => {
    const cmd = argv.join(" ");
    if (cmd.startsWith("git diff --name-only")) {
      return defaultDiffResult;
    }
    if (cmd.includes("bun test")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { stdout: "", stderr: "" };
  });

  const result = await reconcile("h_timeout_2");
  expect(result.status).toBe("test_failed");
  expect(result.timed_out).toBe(true);
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
});

function makeScopedReconciler(
  exec: (argv: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>,
) {
  return createMergeReconciler({
    worktreeManager: new WorktreeManager(),
    postProgress: mock(async () => {}),
    log: mockLog,
    mainRepoDir: "/repo",
    getHandoff: mock(async () => null),
    createDispatchPR: mock(async () => ({
      url: "https://github.com/acordeiro/penumbra/pull/999",
      number: 999,
    })),
    exec,
  });
}

describe("reconciler test step is diff-scoped", () => {
  test("runs bun test packages/daemon/test/ when only daemon changed", async () => {
    const execCalls: string[] = [];
    const exec = async (argv: string[], _opts: { cwd: string }) => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return { stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler("diff-scoped-1");

    expect(execCalls.find((cmd) => cmd.startsWith("bun test"))).toBe(
      "bun test packages/daemon/test/",
    );
  });

  test("skips test step entirely when diff is docs-only", async () => {
    const execCalls: string[] = [];
    const exec = async (argv: string[], _opts: { cwd: string }) => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return { stdout: "docs/plans/foo.md\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler("diff-scoped-2");

    expect(execCalls.find((cmd) => cmd.startsWith("bun test"))).toBeUndefined();
  });

  test("falls back to full bun test when a root file changed", async () => {
    const execCalls: string[] = [];
    const exec = async (argv: string[], _opts: { cwd: string }) => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return { stdout: "packages/daemon/src/foo.ts\nbun.lock\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
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
    const exec = async (argv: string[], _opts: { cwd: string }) => {
      const cmd = argv.join(" ");
      execCalls.push(cmd);
      if (cmd.startsWith("git diff --name-only")) {
        return { stdout: `${maliciousPath}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const reconciler = makeScopedReconciler(exec);
    const result = await reconciler("diff-scoped-invalid");

    expect(result.status).toBe("test_failed");
    expect(result.error_code).toBe("invalid_test_package_path");
    expect(execCalls.some((cmd) => cmd.startsWith("bun test"))).toBe(false);
  });
});
