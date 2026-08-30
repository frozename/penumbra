import type { AgentChatConfig } from "@src/config/types.js";

import { type WorktreeHandle, WorktreeManager } from "@penumbra/core";
import {
  applyWorktreeOverride,
  rewriteWorktreeHandoffMessage,
} from "@src/worker/worktree-integration.js";
import { expect, test } from "bun:test";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const diskFullError = new Error("disk full");
const exec = promisify(execCb);

// AgentChatConfig fixtures are partial — the test only inspects shape under
// `agents[].options`. Single laundering helper keeps the rest of the file
// free of inline casts.
function asConfig(value: unknown): AgentChatConfig {
  return value as AgentChatConfig;
}

// applyWorktreeOverride only depends on createWorktree off the manager type.
// A typed factory lets each test build the spy without spreading a class
// instance (which trips no-misused-spread).
type CreateWorktreeFn = WorktreeManager["createWorktree"];
function asWorktreeManager(impl: {
  createWorktree: CreateWorktreeFn;
  getWorktree?: WorktreeManager["getWorktree"];
  projectRootFor?: WorktreeManager["projectRootFor"];
}): WorktreeManager {
  // applyWorktreeOverride calls projectRootFor unconditionally on the real
  // WorktreeManager type; provide an inert default for mocks that don't care.
  const defaults = { projectRootFor: (): string | undefined => undefined };
  return { ...defaults, ...impl } as unknown as WorktreeManager;
}

// gemini-cli options carry cwd/env at runtime; AgentOptions is a wider union
// in the schema. One typed reader avoids inline `as` per access.
interface CliOptions {
  cwd?: string;
  env?: Record<string, string>;
}
function cliOptions(agent: { options?: unknown } | undefined): CliOptions {
  return agent?.options ?? {};
}

const baseConfig = asConfig({
  agents: [
    {
      name: "gemini",
      adapter: "gemini-cli",
      options: { command: "gemini" },
      roles: [],
      auto_approve_to: [],
      pricing_mode: "api",
    },
    {
      name: "http",
      adapter: "openai-compat-http",
      options: { baseUrl: "url", model: "m" },
      roles: [],
      auto_approve_to: [],
      pricing_mode: "api",
    },
  ],
  default_roles: {},
});

const mainRepoPath = process.cwd();

// Typed factory: prefer-promise-reject-errors requires Error-shaped reasons,
// but the wrap-as-cause test fabricates a non-Error rejection to verify the
// integration wraps it. One documented unknown-as-Error cast inside the
// factory satisfies the rule without weakening the test surface.
function rejectAsNonError(payload: unknown): Promise<never> {
  const reason = payload as Error;
  return Promise.reject(reason);
}

function makeMockWorktreeManager(): WorktreeManager {
  const handles = new Map<string, WorktreeHandle>();

  const createWorktree: CreateWorktreeFn = (id, opts) => {
    if (id === "fail") return Promise.reject(diskFullError);
    if (id === "string-fail") return rejectAsNonError("disk full");

    const handle: WorktreeHandle = {
      handoffId: id,
      branchName: `agent/${id}`,
      createdAt: "",
      status: "created",
      path: `/fake/worktree/${id}`,
      storageRoot: `/fake/worktree/${id}/.test-storage`,
      worktreeMode: opts?.isolated_install ? "isolated_install" : "symlink_mirror",
    };
    handles.set(id, handle);
    return Promise.resolve(handle);
  };

  return asWorktreeManager({
    createWorktree,
    getWorktree: (id: string) => handles.get(id) ?? null,
  });
}

function errorCause(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined;
}

test("Dispatch with adapter kind gemini-cli -> worktree created, cwd/env injected", async () => {
  const wtm = makeMockWorktreeManager();
  const recorded: { handoffId: string; branchName: string }[] = [];
  const { overrideConfig, handle, worktreePromptRewrite } = await applyWorktreeOverride(
    { handoff_id: "h1", to_agent: "gemini", use_worktree: true },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
    undefined,
    {
      recordBranchName: (handoffId, branchName) => {
        recorded.push({ handoffId, branchName });
        return Promise.resolve();
      },
    },
  );
  expect(worktreePromptRewrite).toEqual({
    mainRepoPath,
    worktreePath: "/fake/worktree/h1",
    guardText:
      "This dispatch is isolated to the assigned worktree only.\n" +
      "Work only in: /fake/worktree/h1\n" +
      "Do not read, edit, or commit in the shared main checkout.\n\n" +
      "When running pytest, pip, or any Python tool inside a git worktree, prepend `PYTHONPATH=$PWD` to the command. " +
      "A sibling checkout's .venv can otherwise shadow the worktree's source and make tests run against stale code. " +
      'If behavior looks wrong, verify imports with: python3 -c "import <pkg>; print(<pkg>.__file__)".',
  });
  expect(handle).not.toBeNull();
  expect(handle?.path).toBe("/fake/worktree/h1");
  const agent = overrideConfig.agents.find((a) => a.name === "gemini");
  const opts = cliOptions(agent);
  expect(opts.cwd).toBe("/fake/worktree/h1");
  expect(opts.env?.PENUMBRA_STORAGE_ROOT).toBe("/fake/worktree/h1/.test-storage");
  expect(recorded).toEqual([{ handoffId: "h1", branchName: "agent/h1" }]);
});

test("Dispatch records the final created branch_name after suffix allocation", async () => {
  const handle: WorktreeHandle = {
    handoffId: "h-suffix",
    branchName: "feat/x-2",
    createdAt: "",
    status: "created",
    path: "/fake/worktree/h-suffix",
    storageRoot: "/fake/worktree/h-suffix/.test-storage",
    worktreeMode: "symlink_mirror",
  };
  const recorded: { handoffId: string; branchName: string }[] = [];
  const wtm = asWorktreeManager({
    createWorktree: (id) => {
      expect(id).toBe("h-suffix");
      return Promise.resolve(handle);
    },
    getWorktree: () => handle,
  });

  const result = await applyWorktreeOverride(
    {
      handoff_id: "h-suffix",
      to_agent: "gemini",
      use_worktree: true,
    },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
    undefined,
    {
      recordBranchName: (handoffId, branchName) => {
        recorded.push({ handoffId, branchName });
        return Promise.resolve();
      },
    },
  );

  expect(result.handle?.branchName).toBe("feat/x-2");
  expect(recorded).toEqual([{ handoffId: "h-suffix", branchName: "feat/x-2" }]);
});

test("Dispatch with adapter kind openai-compat-http -> NO worktree created", async () => {
  const wtm = makeMockWorktreeManager();
  const { overrideConfig, handle, worktreePromptRewrite } = await applyWorktreeOverride(
    { handoff_id: "h2", to_agent: "http", use_worktree: true },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
  expect(worktreePromptRewrite).toBeNull();
});

test("Dispatch with use_worktree: false -> NO worktree", async () => {
  const wtm = makeMockWorktreeManager();
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: "h3", to_agent: "gemini", use_worktree: false },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test("Dispatch with use_worktree: false and project_id -> agent cwd points at project root", async () => {
  const mock = makeMockWorktreeManager();
  const wtm = asWorktreeManager({
    createWorktree: mock.createWorktree.bind(mock),
    getWorktree: mock.getWorktree.bind(mock),
  });
  (wtm as unknown as { projectRootFor: (id?: string) => string | undefined }).projectRootFor = (
    id,
  ): string | undefined => (id === "llamactl" ? "/repos/llamactl" : undefined);
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: "h3-root", to_agent: "gemini", use_worktree: false, project_id: "llamactl" },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(cliOptions(overrideConfig.agents.find((a) => a.name === "gemini")).cwd).toBe(
    "/repos/llamactl",
  );
});

test("Dispatch with use_worktree: true on non-worktree-capable adapter and project_id -> agent cwd points at project root", async () => {
  const mock = makeMockWorktreeManager();
  const wtm = asWorktreeManager({
    createWorktree: mock.createWorktree.bind(mock),
    getWorktree: mock.getWorktree.bind(mock),
  });
  (wtm as unknown as { projectRootFor: (id?: string) => string | undefined }).projectRootFor = (
    id,
  ): string | undefined => (id === "llamactl" ? "/repos/llamactl" : undefined);
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: "h3-root-nonwt", to_agent: "http", use_worktree: true, project_id: "llamactl" },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(cliOptions(overrideConfig.agents.find((a) => a.name === "http")).cwd).toBe(
    "/repos/llamactl",
  );
});

test("Worktree creation throws -> propagates error", async () => {
  const wtm = makeMockWorktreeManager();
  let caught: unknown;
  try {
    await applyWorktreeOverride(
      { handoff_id: "fail", to_agent: "gemini", use_worktree: true },
      baseConfig,
      "/storage",
      wtm,
      mainRepoPath,
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("worktree creation failed for fail: disk full");
  expect(errorCause(caught)).toBe(diskFullError);
});

test("Non-Error worktree failure is wrapped as an Error cause", async () => {
  const wtm = makeMockWorktreeManager();
  let caught: unknown;
  try {
    await applyWorktreeOverride(
      { handoff_id: "string-fail", to_agent: "gemini", use_worktree: true },
      baseConfig,
      "/storage",
      wtm,
      mainRepoPath,
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("worktree creation failed for string-fail: disk full");
  const cause = errorCause(caught);
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toBe("disk full");
});

test("applyWorktreeOverride creates the worktree on the passed manager instance", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-integration-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-repo-"));
  await exec("git init -b main", { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# one\n");
  await exec('git add README.md && git commit -m "one"', { cwd: repoDir });
  const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
  const handoffId = `singleton-${String(Date.now())}`;

  try {
    const { handle } = await applyWorktreeOverride(
      { handoff_id: handoffId, to_agent: "gemini", use_worktree: true },
      baseConfig,
      "/storage",
      manager,
      mainRepoPath,
    );

    expect(handle).not.toBeNull();
    expect(manager.getWorktree(handoffId)).toEqual(handle);
  } finally {
    await manager.teardownWorktree(handoffId, true).catch(() => {
      /* best-effort teardown */
    });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("applyWorktreeOverride forwards branch_base to createWorktree", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-integration-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-repo-"));
  await exec("git init -b main", { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# one\n");
  await exec('git add README.md && git commit -m "one"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# two\n");
  await exec('git add README.md && git commit -m "two"', { cwd: repoDir });
  const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
  const handoffId = `singleton-${String(Date.now())}-branch`;

  try {
    const spyManager = asWorktreeManager({
      createWorktree: (id, opts) => {
        expect(id).toBe(handoffId);
        expect(opts?.baseRef).toBe("agent/dep-tip");
        return manager.createWorktree(id, { ...opts, baseRef: "HEAD~1" });
      },
    });
    const { handle } = await applyWorktreeOverride(
      {
        handoff_id: handoffId,
        to_agent: "gemini",
        use_worktree: true,
        branch_base: "agent/dep-tip",
      },
      baseConfig,
      "/storage",
      spyManager,
      mainRepoPath,
    );

    expect(handle).not.toBeNull();
  } finally {
    await manager.teardownWorktree(handoffId, true).catch(() => {
      /* best-effort teardown */
    });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("applyWorktreeOverride forwards isolated_install to createWorktree", async () => {
  const wtm = makeMockWorktreeManager();
  const { handle } = await applyWorktreeOverride(
    {
      handoff_id: "h-isolated",
      to_agent: "gemini",
      use_worktree: true,
      isolated_install: true,
    },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
  );

  expect(handle).not.toBeNull();
  expect(handle?.worktreeMode).toBe("isolated_install");
});

test("applyWorktreeOverride forwards abort signal to worktree creation", async () => {
  const abort = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const inner = makeMockWorktreeManager();
  const spyManager = asWorktreeManager({
    createWorktree: (id, opts) => {
      observedSignal = opts?.signal;
      return inner.createWorktree(id, opts);
    },
  });

  await applyWorktreeOverride(
    {
      handoff_id: "h-signal",
      to_agent: "gemini",
      use_worktree: true,
      isolated_install: true,
    },
    baseConfig,
    "/storage",
    spyManager,
    mainRepoPath,
    { signal: abort.signal },
  );

  expect(observedSignal).toBe(abort.signal);
});

test("applyWorktreeOverride leaves dispatch event emission to the worker layer", async () => {
  const wtm = makeMockWorktreeManager();

  const result = await applyWorktreeOverride(
    {
      handoff_id: "h-setup-event",
      project_id: null,
      to_agent: "gemini",
      use_worktree: true,
      isolated_install: true,
    },
    baseConfig,
    "/storage",
    wtm,
    mainRepoPath,
    {},
  );

  // The slimmed WorktreeSetupContext carries no event channel at all — event
  // emission is structurally the worker layer's job. Assert the result shape
  // has no event side channel either.
  expect(Object.keys(result)).toEqual(["overrideConfig", "handle", "worktreePromptRewrite"]);
  expect(result.handle).toBeTruthy();
});

test("rewriteWorktreeHandoffMessage rewrites main-repo paths and adds isolation guard", () => {
  const rewritten = rewriteWorktreeHandoffMessage(
    `Please update ${mainRepoPath}/src/index.ts and /tmp`,
    {
      mainRepoPath,
      worktreePath: "/fake/worktree/h1",
      guardText:
        `This dispatch is isolated to the assigned worktree only.\n` +
        `Work only in: /fake/worktree/h1\n` +
        "Do not read, edit, or commit in the shared main checkout.\n\n" +
        "When running pytest, pip, or any Python tool inside a git worktree, prepend `PYTHONPATH=$PWD` to the command. " +
        "A sibling checkout's .venv can otherwise shadow the worktree's source and make tests run against stale code. " +
        'If behavior looks wrong, verify imports with: python3 -c "import <pkg>; print(<pkg>.__file__)".',
    },
  );
  const [rewrittenMessageBody] = rewritten.split("\n\n", 2);

  expect(rewritten).toContain("/fake/worktree/h1/src/index.ts");
  expect(rewritten).toContain("/fake/worktree/h1");
  expect(rewrittenMessageBody).not.toContain(mainRepoPath);
  expect(rewritten).toContain("This dispatch is isolated to the assigned worktree only.");
  expect(rewritten).toContain("Do not read, edit, or commit in the shared main checkout.");
  expect(rewritten).toContain("prepend `PYTHONPATH=$PWD`");
});
