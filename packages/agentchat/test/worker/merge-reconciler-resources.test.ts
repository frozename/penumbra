import {
  createHeavyJobGate,
  createLogger,
  type HandoffRow,
  type HeavyJobGate,
  HeavyJobLock,
  type Logger,
  WorktreeManager,
} from "@penumbra/core";
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMergeReconciler,
  type MergeResult,
  type ReconcilerDeps,
} from "@src/worker/merge-reconciler.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

// Shapes a child_process error: a numeric code, or a null code plus the signal.
class ExecCommandError extends Error {
  public readonly stderr: string;
  public readonly stdout: string;
  public readonly code: number | null;
  public readonly signal: string | null;
  constructor(init: { stderr?: string; stdout?: string; code?: number | null; signal?: string }) {
    super(init.stderr ?? "");
    this.name = "ExecCommandError";
    this.stderr = init.stderr ?? "";
    this.stdout = init.stdout ?? "";
    this.code = init.code ?? null;
    this.signal = init.signal ?? null;
  }
}

const root = mkdtempSync(join(tmpdir(), "penumbra-reconcile-resources-"));
const quietLog = createLogger({ component: "reconcile-resources-test", level: "silent" });
const execHistory: string[] = [];
const worktreePaths = new Map<string, string>();
let bunTestBehaviour: () => Promise<ExecResult> = () => Promise.resolve({ stdout: "", stderr: "" });
let tscBehaviour: (handoffId: string) => Promise<ExecResult> = () =>
  Promise.resolve({ stdout: "", stderr: "" });

function makeHandoffRow(handoffId: string): HandoffRow {
  return {
    handoff_id: handoffId,
    ts: "2026-10-21T00:00:00.000Z",
    project_id: null,
    conversation_id: `c-${handoffId}`,
    from_agent: "user",
    to_agent: "codex",
    to_role: null,
    message: "resource limits",
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
  } as unknown as HandoffRow;
}

function makeTestLogger(): Logger {
  const stub = {
    info: mock((..._args: unknown[]) => undefined),
    warn: mock((..._args: unknown[]) => undefined),
    debug: mock((..._args: unknown[]) => undefined),
    error: mock((..._args: unknown[]) => undefined),
  };
  return stub as unknown as Logger;
}

const execMock = mock((argv: string[], opts: { cwd: string }): Promise<ExecResult> => {
  const cmd = argv.join(" ");
  execHistory.push(cmd);
  if (cmd.startsWith("git diff --name-only")) {
    return Promise.resolve({ stdout: "packages/daemon/src/routes/handoffs.ts\n", stderr: "" });
  }
  if (cmd === "git rev-parse HEAD") return Promise.resolve({ stdout: "branch-head\n", stderr: "" });
  if (cmd === "git rev-parse main") return Promise.resolve({ stdout: "base-head\n", stderr: "" });
  if (cmd === "git merge-base base-head branch-head") {
    return Promise.resolve({ stdout: "merge-base\n", stderr: "" });
  }
  if (cmd.startsWith("bun tsc -b")) {
    return tscBehaviour(opts.cwd.replace("/worktree/", ""));
  }
  if (cmd.startsWith("bun test")) return bunTestBehaviour();
  return Promise.resolve({ stdout: "", stderr: "" });
});

const captured: { handoffId: string; result: MergeResult }[] = [];

function makeDeps(heavyStageGate?: HeavyJobGate): ReconcilerDeps {
  return {
    worktreeManager: new WorktreeManager(),
    postProgress: mock(() => Promise.resolve()),
    captureResult: mock((handoffId: string, result: MergeResult) => {
      captured.push({ handoffId, result });
      return Promise.resolve();
    }),
    emitVerdict: mock(() => Promise.resolve()),
    log: makeTestLogger(),
    mainRepoDir: "/main/repo",
    getHandoff: mock((handoffId: string) => Promise.resolve(makeHandoffRow(handoffId))),
    exec: execMock,
    settings: { reconcileTypecheckTimeoutSec: 120, reconcileTestTimeoutSec: 300 },
    ...(heavyStageGate ? { heavyStageGate } : {}),
  };
}

const getWorktreeSpy = spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation(
  (id: string) => ({
    handoffId: id,
    path: worktreePaths.get(id) ?? `/worktree/${id}`,
    branchName: `agent/${id}`,
    storageRoot: `/worktree/${id}/.test-storage`,
    createdAt: "",
    status: "created" as const,
    worktreeMode: "symlink_mirror" as const,
  }),
);

afterAll(() => {
  getWorktreeSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  execHistory.length = 0;
  captured.length = 0;
  tscBehaviour = (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "" });
  bunTestBehaviour = (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "" });
});

test("a SIGKILLed typecheck is a resource kill, not a typecheck failure charged to the agent", async () => {
  tscBehaviour = (): Promise<ExecResult> =>
    Promise.reject(
      new ExecCommandError({ stdout: "Building project…\n", code: null, signal: "SIGKILL" }),
    );
  const result = await createMergeReconciler(makeDeps())("h-oom");
  expect(result).toMatchObject({
    status: "typecheck_failed",
    verification_environment_error: true,
    resource_killed: true,
  });
  expect(result.regression_summary).toContain("job scope MemoryMax or host OOM");
  expect(captured[0]?.result.resource_killed).toBe(true);
});

test("exit 137 from a shell wrapper counts as a resource kill too", async () => {
  tscBehaviour = (): Promise<ExecResult> =>
    Promise.reject(new ExecCommandError({ stdout: "partial", stderr: "Killed\n", code: 137 }));
  const result = await createMergeReconciler(makeDeps())("h-137");
  expect(result).toMatchObject({ resource_killed: true, verification_environment_error: true });
});

test("systemd-run failing to start the scope is an environment failure", async () => {
  tscBehaviour = (): Promise<ExecResult> =>
    Promise.reject(
      new ExecCommandError({
        stderr: "Failed to start transient scope unit: Connection timed out\n",
        code: 1,
      }),
    );
  const result = await createMergeReconciler(makeDeps())("h-scope");
  expect(result).toMatchObject({
    status: "typecheck_failed",
    verification_environment_error: true,
  });
  expect(result.resource_killed).toBeUndefined();
});

test("an ordinary typecheck failure is still charged to the agent", async () => {
  tscBehaviour = (): Promise<ExecResult> =>
    Promise.reject(
      new ExecCommandError({
        stdout:
          "packages/daemon/src/routes/handoffs.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        code: 2,
      }),
    );
  const result = await createMergeReconciler(makeDeps())("h-real");
  expect(result.status).toBe("typecheck_failed");
  expect(result.verification_environment_error).toBeUndefined();
  expect(result.resource_killed).toBeUndefined();
});

test("an admission timeout skips the stage and reports a resource environment failure", async () => {
  const gate: HeavyJobGate = {
    enter: (): ReturnType<HeavyJobGate["enter"]> =>
      Promise.resolve({
        ok: false,
        reason: "host memory admission timeout: MemAvailable 9.0 GiB < 20 GiB after 900s",
      }),
  };
  const result = await createMergeReconciler(makeDeps(gate))("h-admit");
  expect(result).toMatchObject({
    status: "typecheck_failed",
    verification_environment_error: true,
    resource_admission_timeout: true,
  });
  expect(execHistory.some((cmd) => cmd.startsWith("bun tsc"))).toBe(false);
});

test("heavy stages are serialized across concurrent reconciles", async () => {
  const lock = new HeavyJobLock({ path: join(root, "heavy.lock"), flockBin: null, log: quietLog });
  const gate = createHeavyJobGate({ lock, admitMinGiB: 0, waitMs: 10_000, log: quietLog });
  let inFlight = 0;
  let maxInFlight = 0;
  const releases = new Map<string, () => void>();
  tscBehaviour = (handoffId): Promise<ExecResult> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      releases.set(handoffId, () => {
        inFlight--;
        resolve({ stdout: "", stderr: "" });
      });
    });
  };
  const reconcile = createMergeReconciler(makeDeps(gate));
  const first = reconcile("h-a");
  const second = reconcile("h-b");
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  await until(() => releases.size === 1);
  await new Promise((r) => setTimeout(r, 50));
  expect(releases.size).toBe(1);
  const [firstId] = [...releases.keys()];
  releases.get(firstId ?? "")?.();
  await until(() => releases.size === 2);
  for (const [id, release] of releases) if (id !== firstId) release();
  await Promise.all([first, second]);
  expect(maxInFlight).toBe(1);
});

test("a bun test run SIGKILLed after printing output is a resource kill, not test_failed", async () => {
  const wt = join(root, "wt-tests-oom");
  mkdirSync(join(wt, "node_modules", "@penumbra", "core"), { recursive: true });
  worktreePaths.set("h-tests-oom", wt);
  bunTestBehaviour = (): Promise<ExecResult> =>
    Promise.reject(
      new ExecCommandError({
        stdout: "packages/daemon/test/a.test.ts:\n(pass) a > b [3.00ms]\n",
        code: null,
        signal: "SIGKILL",
      }),
    );
  const result = await createMergeReconciler(makeDeps())("h-tests-oom");
  expect(execHistory).toContain("bun test packages/daemon/test/");
  expect(result).toMatchObject({
    status: "test_failed",
    verification_environment_error: true,
    resource_killed: true,
  });
});
