import { type HandoffRow, type Logger, WorktreeManager } from "@penumbra/core";
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMergeReconciler, type ReconcilerDeps } from "../../src/worker/merge-reconciler.js";

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

interface LogCall {
  payload: unknown;
  msg: unknown;
}

const execHistory: string[] = [];
let diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
let nextExecResult: ExecResult = { stdout: "", stderr: "" };
const execFailures = new Map<string, ExecCommandError>();
const warnCalls: LogCall[] = [];
const infoCalls: LogCall[] = [];
const errorCalls: LogCall[] = [];
let worktreePath = process.cwd();

// HandoffRow's Zod preprocessors make the inferred TS type narrower than the
// runtime schema accepts. ONE documented `as unknown as HandoffRow` cast in
// this typed factory bridges that gap once for every fixture.
function makeHandoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  const base = {
    handoff_id: "h1",
    ts: "2026-05-12T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-123",
    from_agent: "user",
    to_agent: "codex",
    to_role: null,
    message: "scope typecheck",
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
function makeTestLogger(): Logger {
  const stub = {
    info: mock((payload: unknown, msg?: unknown) => {
      infoCalls.push({ payload, msg });
    }),
    debug: mock((..._args: unknown[]) => undefined),
    error: mock((payload: unknown, msg?: unknown) => {
      errorCalls.push({ payload, msg });
    }),
    warn: mock((payload: unknown, msg?: unknown) => {
      warnCalls.push({ payload, msg });
    }),
  };
  return stub as unknown as Logger;
}

const execMock = mock((argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
  const cmd = argv.join(" ");
  execHistory.push(cmd);
  for (const [pattern, error] of execFailures) {
    if (cmd.includes(pattern)) return Promise.reject(error);
  }
  if (cmd === "git rev-parse HEAD") {
    return Promise.resolve({ stdout: "branch-head\n", stderr: "" });
  }
  if (cmd === "git rev-parse main") {
    return Promise.resolve({ stdout: "base-head\n", stderr: "" });
  }
  if (cmd === "git merge-base base-head branch-head") {
    return Promise.resolve({ stdout: "merge-base\n", stderr: "" });
  }
  if (cmd.startsWith("git diff --name-only")) {
    return Promise.resolve({ stdout: diffOutput, stderr: "" });
  }
  if (cmd === "git rev-parse HEAD") {
    return Promise.resolve({ stdout: "branch-head\n", stderr: "" });
  }
  if (cmd === "git rev-parse main") {
    return Promise.resolve({ stdout: "base-head\n", stderr: "" });
  }
  if (cmd === "git merge-base base-head branch-head") {
    return Promise.resolve({ stdout: "merge-base\n", stderr: "" });
  }
  return Promise.resolve(nextExecResult);
});

const mockDeps: ReconcilerDeps = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock((_handoffId: string, _payload: unknown) => Promise.resolve()),
  notifyResult: mock(() => Promise.resolve()),
  captureResult: mock(() => Promise.resolve()),
  emitVerdict: mock(() => Promise.resolve()),
  log: makeTestLogger(),
  mainRepoDir: process.cwd(),
  getHandoff: mock((_handoffId: string) => Promise.resolve(makeHandoffRow())),
  createDispatchPR: mock(() =>
    Promise.resolve({
      url: "https://github.com/frozename/penumbra/pull/1",
      number: 1,
    }),
  ),
  exec: execMock,
  settings: {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  },
};

const getWorktreeSpy = spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation(
  (id: string) => ({
    handoffId: id,
    path: worktreePath,
    branchName: `agent/${id}`,
    storageRoot: `${worktreePath}/.test-storage`,
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
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  nextExecResult = { stdout: "", stderr: "" };
  execFailures.clear();
  warnCalls.length = 0;
  infoCalls.length = 0;
  errorCalls.length = 0;
  worktreePath = process.cwd();
});

function makeReconciler(): ReturnType<typeof createMergeReconciler> {
  return createMergeReconciler(mockDeps);
}

test("clean post-merge typecheck passes", async () => {
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.startsWith("bun tsc -b packages/core"))).toBe(true);
  expect(warnCalls).toHaveLength(0);
});

test("pre-existing typecheck errors outside the diff do not fail reconciliation", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures.set(
    "bun tsc -b",
    new ExecCommandError({
      stderr:
        'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n' +
        'packages/core/src/index.ts(2,3): error TS2322: Type "string" is not assignable to type "number".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.startsWith("bun tsc -b packages/core"))).toBe(true);
  expect(warnCalls).toHaveLength(1);
  const warnPayload = warnCalls[0]?.payload as Record<string, unknown> | undefined;
  expect(warnPayload?.component).toBe("reconciler-typecheck-baseline-filter");
  expect(warnPayload?.handoff_id).toBe("h1");
  expect(warnPayload?.pre_existing_error_count).toBe(2);
  expect(
    infoCalls.some((call) => call.msg === "reconciliation complete — verified without PR"),
  ).toBe(true);
});

test("mixed typecheck failures only attribute changed-file errors", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures.set(
    "packages/daemon",
    new ExecCommandError({
      stderr:
        'packages/daemon/src/routes/handoffs.ts(12,5): error TS2345: Argument of type "string" is not assignable to parameter of type "number".\n' +
        'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:12:5 TS2345");
  expect(result.regression_summary).not.toContain("packages/core/src/index.ts");
});

test("typecheck failures in unchanged files within the changed package still fail reconciliation", async () => {
  diffOutput = "packages/agentchat/src/worker/merge-reconciler.ts\n";
  execFailures.set(
    "bun tsc -b packages/core packages/agentchat",
    new ExecCommandError({
      stderr:
        'packages/agentchat/src/worker/merge-reconciler-sibling.ts(4,7): error TS2322: Type "number" is not assignable to type "string".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain(
    "packages/agentchat/src/worker/merge-reconciler-sibling.ts:4:7 TS2322",
  );
});

test("typecheck failures in reverse-dependent workspace packages still fail reconciliation", async () => {
  diffOutput = "packages/core/src/index.ts\n";
  execFailures.set(
    "packages/daemon",
    new ExecCommandError({
      stderr:
        'packages/daemon/src/routes/handoffs.ts(18,9): error TS2339: Property "foo" does not exist on type "Bar".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:18:9 TS2339");
});

test("mixed typecheck failures include direct and closure hits but exclude pre-existing errors", async () => {
  diffOutput = "packages/agentchat/src/worker/merge-reconciler.ts\n";
  execFailures.set(
    "packages/daemon",
    new ExecCommandError({
      stderr:
        'packages/agentchat/src/worker/merge-reconciler.ts(12,5): error TS2345: Argument of type "string" is not assignable to parameter of type "number".\n' +
        'packages/daemon/src/routes/handoffs.ts(18,9): error TS2339: Property "foo" does not exist on type "Bar".\n' +
        'packages/workflows/src/schema.ts(7,3): error TS2322: Type "boolean" is not assignable to type "string".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain(
    "packages/agentchat/src/worker/merge-reconciler.ts:12:5 TS2345",
  );
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:18:9 TS2339");
  expect(result.regression_summary).not.toContain("packages/workflows/src/schema.ts");
});

test("parse failures fall back to raw typecheck output", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures.set("bun tsc -b", new ExecCommandError({ stderr: "this is not a ts error line\n" }));
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("this is not a ts error line");
  expect(
    warnCalls.some(
      (call) =>
        typeof call.payload === "object" &&
        call.payload !== null &&
        (call.payload as { component?: unknown }).component ===
          "reconciler-typecheck-parse-fallback",
    ),
  ).toBe(true);
});

test("full-tree fallback attributes any package diagnostic", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n../scripts/tool.ts\n";
  execFailures.set(
    "bun tsc -b",
    new ExecCommandError({
      stderr:
        'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n' +
        'packages/daemon/src/routes/handoffs.ts(9,2): error TS2339: Property "x" does not exist on type "never".\n',
    }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/core/src/index.ts:1:1 TS2304");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:9:2 TS2339");
});

test("includes malformed workspace packages in the scoped build set and logs an error", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "merge-reconciler-worktree-"));
  worktreePath = tmpRoot;
  fs.mkdirSync(path.join(tmpRoot, "packages", "daemon", "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "packages", "brokenpkg"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "packages", "daemon", "package.json"),
    JSON.stringify({
      name: "@penumbra/daemon",
      dependencies: { "@penumbra/brokenpkg": "workspace:*" },
    }),
  );
  fs.writeFileSync(path.join(tmpRoot, "packages", "brokenpkg", "package.json"), "{");

  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain("bun tsc -b packages/core packages/brokenpkg packages/daemon");
  expect(
    errorCalls.some((call) =>
      String(call.msg).includes("workspace package manifest missing or invalid"),
    ),
  ).toBe(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
