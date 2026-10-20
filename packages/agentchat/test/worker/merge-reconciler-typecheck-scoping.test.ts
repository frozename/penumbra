import { type HandoffRow, type Logger, WorktreeManager } from "@penumbra/core";
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMergeReconciler, type ReconcilerDeps } from "@src/worker/merge-reconciler.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

// Errors thrown from the exec mock carry stderr/code/stdout so the production
// runGitProbe helper can read them off via duck-typing. Using a real Error
// subclass keeps the throw-site compatible with `@typescript-eslint/only-throw-error`.
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

const execHistory: string[] = [];
const execFailures = new Map<string, ExecCommandError>();
let diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
let worktreePath: string | null = null;
const temporaryRoots: string[] = [];

// HandoffRow has Zod preprocessors (use_worktree, open_pr_on_review, isolated_install)
// whose inferred output type is `boolean | null` even though the runtime schema
// also accepts numeric 0/1. ONE documented `as unknown as HandoffRow` cast inside
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

// Pino's Logger interface has many methods; tests only consume info/warn/debug/error
// (and merge-reconciler logs nothing else through this surface). One documented
// `as unknown as Logger` cast inside this factory keeps the rest of the file Logger-typed.
function makeTestLogger(): Logger {
  const stub = {
    info: mock((..._args: unknown[]) => undefined),
    warn: mock((..._args: unknown[]) => undefined),
    debug: mock((..._args: unknown[]) => undefined),
    error: mock((..._args: unknown[]) => undefined),
  };
  return stub as unknown as Logger;
}

const execMock = mock((argv: string[], _opts: { cwd: string }): Promise<ExecResult> => {
  const cmd = argv.join(" ");
  execHistory.push(cmd);
  for (const [pattern, error] of execFailures) {
    if (cmd.includes(pattern)) return Promise.reject(error);
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
  return Promise.resolve({ stdout: "", stderr: "" });
});

const mockDeps: ReconcilerDeps = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock((_handoffId: string, _payload: unknown) => Promise.resolve()),
  notifyResult: mock(() => Promise.resolve()),
  captureResult: mock(() => Promise.resolve()),
  emitVerdict: mock(() => Promise.resolve()),
  log: makeTestLogger(),
  mainRepoDir: "/main/repo",
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
    path: worktreePath ?? `/worktree/${id}`,
    branchName: `agent/${id}`,
    storageRoot: `/worktree/${id}/.test-storage`,
    createdAt: "",
    status: "created" as const,
    worktreeMode: "symlink_mirror" as const,
  }),
);

afterAll(() => {
  getWorktreeSpy.mockRestore();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  execHistory.length = 0;
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures.clear();
  worktreePath = null;
});

function makeReconciler(): ReturnType<typeof createMergeReconciler> {
  return createMergeReconciler(mockDeps);
}

test("scopes typecheck to the affected package when one package changed", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain(
    "bun tsc -b packages/agentchat packages/cli packages/core packages/daemon packages/mcp packages/workflows",
  );
  expect(execHistory).not.toContain("bun run typecheck");
});

test("limits scoped reverse dependencies to the root TypeScript build graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-reconciler-build-graph-"));
  temporaryRoots.push(root);
  worktreePath = root;
  const packages = ["agentchat", "cli", "config", "core", "daemon", "e2e", "mcp", "workflows"];
  for (const name of packages) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    const dependsOnDaemon = ["agentchat", "cli", "e2e", "mcp", "workflows"].includes(name);
    const dependencies = dependsOnDaemon
      ? { "@penumbra/daemon": "workspace:*" }
      : name === "daemon"
        ? { "@penumbra/config": "workspace:*", "@penumbra/core": "workspace:*" }
        : {};
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ name: `@penumbra/${name}`, dependencies }),
    );
    writeFileSync(
      join(root, "packages", name, "tsconfig.json"),
      JSON.stringify({
        references: name === "daemon" ? [{ path: "../config" }, { path: "../core" }] : [],
      }),
    );
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      references: ["agentchat", "cli", "core", "daemon", "mcp", "workflows"].map((name) => ({
        path: `./packages/${name}`,
      })),
    }),
  );
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";

  await makeReconciler()("h-build-graph");

  expect(execHistory).toContain(
    "bun tsc -b packages/core packages/agentchat packages/cli packages/daemon packages/mcp packages/workflows",
  );
  expect(execHistory.some((cmd) => cmd.includes("packages/e2e"))).toBe(false);
});

test("scopes typecheck to multiple affected packages", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\npackages/mcp/src/server.ts\n";
  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain(
    "bun tsc -b packages/agentchat packages/cli packages/core packages/daemon packages/mcp packages/workflows",
  );
  expect(execHistory).not.toContain("bun run typecheck");
});

test("does not duplicate packages/core when it is already affected", async () => {
  diffOutput = "packages/core/src/index.ts\npackages/daemon/src/routes/handoffs.ts\n";
  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain(
    "bun tsc -b packages/agentchat packages/cli packages/core packages/daemon packages/mcp packages/workflows",
  );
});

test("skips typecheck for docs-only diffs", async () => {
  diffOutput = "docs/superpowers/plans/quality-push.md\n";
  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory.find((cmd) => cmd.includes("typecheck"))).toBeUndefined();
});

test("falls back to full-tree typecheck when git diff fails", async () => {
  execFailures.set("git diff --name-only", new ExecCommandError({ stderr: "diff failed" }));
  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain("bun tsc -b");
});

test("reports scoped typecheck failures with affected packages in the regression summary", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\npackages/mcp/src/server.ts\n";
  execFailures.set(
    "bun tsc -b packages/agentchat packages/cli packages/core packages/daemon packages/mcp packages/workflows",
    new ExecCommandError({ stderr: "tsc failed" }),
  );
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/core");
  expect(result.regression_summary).toContain("packages/daemon");
  expect(result.regression_summary).toContain("packages/mcp");
});

test("scopes typecheck to a nested workspace package instead of its grouping directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-reconciler-nested-pkg-"));
  temporaryRoots.push(root);
  worktreePath = root;
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  mkdirSync(join(root, "packages", "integrations", "typesafe"), { recursive: true });
  writeFileSync(
    join(root, "packages", "core", "package.json"),
    JSON.stringify({ name: "@penumbra/core" }),
  );
  writeFileSync(
    join(root, "packages", "integrations", "typesafe", "package.json"),
    JSON.stringify({ name: "@penumbra/typesafe" }),
  );
  writeFileSync(
    join(root, "packages", "core", "tsconfig.json"),
    JSON.stringify({ references: [] }),
  );
  writeFileSync(
    join(root, "packages", "integrations", "typesafe", "tsconfig.json"),
    JSON.stringify({ references: [{ path: "../../core" }] }),
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      references: [{ path: "./packages/core" }, { path: "./packages/integrations/typesafe" }],
    }),
  );
  diffOutput = "packages/integrations/typesafe/src/client.ts\n";

  await makeReconciler()("h-nested-pkg");

  const tscCmd = execHistory.find((cmd) => cmd.startsWith("bun tsc -b "));
  expect(tscCmd).toBe("bun tsc -b packages/core packages/integrations/typesafe");
  expect(tscCmd?.split(" ")).not.toContain("packages/integrations");
});
