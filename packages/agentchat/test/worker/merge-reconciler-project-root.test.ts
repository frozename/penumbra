import {
  createLogger,
  type HandoffRow,
  type WorktreeHandle,
  WorktreeManager,
} from "@penumbra/core";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMergeReconciler, type ReconcilerVerdict } from "@src/worker/merge-reconciler.js";

const execFileAsync = promisify(execFile);

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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
}

function registeredWorktrees(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function hasCommit(repo: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type CommandStub = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

function commandFailure(stdout: string, code: number): Error {
  return Object.assign(new Error(`command exited with ${String(code)}`), {
    code,
    stdout,
    stderr: "",
  });
}

const FOO_TYPE_ERROR =
  "packages/foo/src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n";

const FOO_TEST_FAILURE = `(fail) foo > breaks [2.00ms]
error: expect(received).toBe(expected)

 8 pass
 1 fail
 0 error
Ran 9 tests across 1 files. [12.00ms]
`;

interface BaselineRun {
  cwd: string;
  localCache: string | null;
  sharedDependency: string | null;
}

function observeBaseline(cwd: string): BaselineRun {
  const marker = join(cwd, "local_cache", "marker");
  const sharedLink = join(cwd, "..", "shared");
  return {
    cwd,
    localCache: existsSync(marker) ? readFileSync(marker, "utf8") : null,
    sharedDependency: existsSync(sharedLink) ? realpathSync(sharedLink) : null,
  };
}

function failingTypecheck(onTypecheck: () => void = () => undefined): CommandStub {
  return (argv) => {
    const command = argv.join(" ");
    if (!command.startsWith("bun tsc -b ")) {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    onTypecheck();
    return Promise.reject(commandFailure(FOO_TYPE_ERROR, 2));
  };
}

describe("merge reconciler project repo resolution (#219)", () => {
  let tmp: string;
  let repoA: string;
  let repoB: string;
  let repoC: string;
  let worktree: WorktreeHandle;
  let verdicts: ReconcilerVerdict[];
  const handoffId = "h-pr-219";

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-reconcile-project-root-")));
    repoA = join(tmp, "worker", "a");
    repoB = join(tmp, "b");
    repoC = join(tmp, "c");

    gitInit(repoA);
    git(repoA, ["commit", "--allow-empty", "-m", "init"]);

    gitInit(repoB);
    writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "b", private: true }));
    git(repoB, ["add", "package.json"]);
    git(repoB, ["commit", "-m", "init"]);

    git(repoB, ["checkout", "-b", "feature/only-in-b"]);
    writeFileSync(join(repoB, "feat.txt"), "feat");
    git(repoB, ["add", "feat.txt"]);
    git(repoB, ["commit", "-m", "feat only in b"]);
    git(repoB, ["checkout", "main"]);

    verdicts = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function commitWorktreeChange(path: string, change: "docs" | "package"): void {
    if (change === "docs") {
      mkdirSync(join(path, "docs"));
      writeFileSync(join(path, "docs", "note.md"), "# note\n");
      git(path, ["add", "docs/note.md"]);
      git(path, ["commit", "-m", "docs note"]);
      return;
    }
    mkdirSync(join(path, "packages", "foo", "src"), { recursive: true });
    writeFileSync(
      join(path, "packages", "foo", "package.json"),
      JSON.stringify({ name: "@b/foo", version: "0.0.0" }),
    );
    writeFileSync(join(path, "packages", "foo", "src", "index.ts"), "export const foo = 1;\n");
    git(path, ["add", "packages/foo"]);
    git(path, ["commit", "-m", "foo package"]);
    mkdirSync(join(path, "node_modules", "@penumbra", "core"), { recursive: true });
  }

  function seedTestStageProject(lockfile: string | null): void {
    mkdirSync(join(tmp, "shared"));
    writeFileSync(
      join(tmp, "shared", "package.json"),
      JSON.stringify({ name: "shared", version: "0.0.0" }),
    );
    writeFileSync(
      join(repoB, "package.json"),
      JSON.stringify({ name: "b", private: true, dependencies: { shared: "file:../shared" } }),
    );
    git(repoB, ["add", "package.json"]);
    if (lockfile !== null) {
      writeFileSync(join(repoB, "bun.lock"), lockfile);
      git(repoB, ["add", "bun.lock"]);
    }
    git(repoB, ["commit", "-m", "test-stage fixture"]);
    mkdirSync(join(repoB, "local_cache"));
    writeFileSync(join(repoB, "local_cache", "marker"), "project-b cache\n");
    mkdirSync(join(repoA, "local_cache"));
    writeFileSync(join(repoA, "local_cache", "marker"), "worker checkout cache\n");
  }

  function testStageCommands(baselineRuns: BaselineRun[]): CommandStub {
    return (argv, cwd) => {
      const command = argv.join(" ");
      if (command.startsWith("bun tsc -b ")) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "bun install --ignore-scripts --frozen-lockfile") {
        mkdirSync(join(cwd, "node_modules", "@penumbra", "core"), { recursive: true });
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command === "bun test packages/foo/test/") {
        if (cwd.startsWith(join(tmp, "scratch"))) baselineRuns.push(observeBaseline(cwd));
        return Promise.reject(commandFailure(FOO_TEST_FAILURE, 1));
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    };
  }

  async function setup(
    branchBase: string | null,
    opts: {
      handoffMissing?: boolean;
      autoRebase?: boolean;
      change?: "docs" | "package";
      handoffId?: string;
      projectId?: string;
      runCommand?: CommandStub;
    } = {},
  ): Promise<ReturnType<typeof createMergeReconciler>> {
    const id = opts.handoffId ?? handoffId;
    const projectId = opts.projectId ?? "proj-b";
    const projectRoots = new Map([
      ["proj-b", repoB],
      ["proj-c", repoC],
    ]);
    const manager = new WorktreeManager({
      rootDir: join(tmp, "default-worktrees"),
      mainRepoDir: repoA,
      resolveProjectRoot: (projectKey: string): string | undefined => projectRoots.get(projectKey),
    });

    const handle = await manager.createWorktree(id, {
      project_id: projectId,
      baseRef: branchBase ?? undefined,
    });
    commitWorktreeChange(handle.path, opts.change ?? "docs");
    worktree = handle;

    const reconciler = createMergeReconciler({
      worktreeManager: manager,
      mainRepoDir: repoA,
      reconcilerAutoRebase: opts.autoRebase ?? false,
      rebaseScratchRoot: join(tmp, "scratch"),
      log: createLogger({ component: "test", level: "silent" }),
      postProgress: mock(() => Promise.resolve()),
      emitVerdict: (v: ReconcilerVerdict) => {
        verdicts.push(v);
      },
      getHandoff: mock(() =>
        Promise.resolve(
          opts.handoffMissing
            ? null
            : makeHandoffRow({
                handoff_id: id,
                project_id: projectId,
                branch_base: branchBase,
              }),
        ),
      ),
      exec: async (argv: string[], execOpts: { cwd: string }) => {
        if (argv[0] === "git") {
          const { stdout, stderr } = await execFileAsync("git", argv.slice(1), {
            cwd: execOpts.cwd,
            encoding: "utf8",
          });
          return { stdout, stderr };
        }
        if (opts.runCommand) return await opts.runCommand(argv, execOpts.cwd);
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    return reconciler;
  }

  test("reconciles a feature branch_base that exists only in the project repo", async () => {
    const reconciler = await setup("feature/only-in-b");
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const expected = git(repoB, ["rev-parse", "feature/only-in-b"]).trim();
    expect(verdicts[0]?.base_sha).toBe(expected);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });

  test("default branch_base reconciles against the project main, not the worker checkout", async () => {
    const reconciler = await setup(null);
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    const repoAMain = git(repoA, ["rev-parse", "main"]).trim();
    expect(verdicts[0]?.base_sha).toBe(repoBMain);
    expect(verdicts[0]?.base_sha).not.toBe(repoAMain);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });

  test("resolves the project from the worktree when the handoff lookup fails", async () => {
    const reconciler = await setup(null, { handoffMissing: true });
    const result = await reconciler(handoffId);
    expect(result.status).toBe("verified");
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    expect(verdicts[0]?.base_sha).toBe(repoBMain);
    expect(verdicts[0]?.ff_mergeable).toBe(true);
  });

  test("auto-rebase replaces a stale scratch worktree and rebases in the project repo", async () => {
    const reconciler = await setup(null, { autoRebase: true });
    // git refuses to check out a branch another worktree holds, so the
    // dispatch checkout must leave the branch for the scratch rebase to run.
    git(worktree.path, ["checkout", "--detach"]);
    writeFileSync(join(repoB, "base.txt"), "base\n");
    git(repoB, ["add", "base.txt"]);
    git(repoB, ["commit", "-m", "advance main"]);
    const scratchPath = join(tmp, "scratch", handoffId);
    git(repoB, ["worktree", "add", "--detach", scratchPath, "main"]);

    const result = await reconciler(handoffId);

    expect(result.status).toBe("verified");
    expect(verdicts[0]?.rebase_attempted).toBe(true);
    expect(verdicts[0]?.rebase_result).toBe("success_local_only");
    expect(verdicts[0]?.rebased_branch).toBe(worktree.branchName);
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    expect(git(repoB, ["merge-base", repoBMain, worktree.branchName]).trim()).toBe(repoBMain);
    expect(registeredWorktrees(repoB)).not.toContain(scratchPath);
  });

  test("recomputes verdict diff stats in the project repo after a hard typecheck failure", async () => {
    const reconciler = await setup(null, { change: "package", runCommand: failingTypecheck() });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("typecheck_failed");
    expect(verdicts[0]?.typecheck).toBe("fail");
    expect(verdicts[0]?.files_changed).toBe(2);
    expect(verdicts[0]?.lines_added).toBe(2);
  });

  test("refreshes the verdict snapshot from the project repo branch when the reconciled head is gone", async () => {
    const reconciler = await setup(null, {
      change: "package",
      runCommand: failingTypecheck(() => {
        git(worktree.path, ["commit", "--amend", "-m", "foo package, amended"]);
        git(repoB, ["reflog", "expire", "--expire=now", "--all"]);
        git(repoB, ["gc", "--prune=now", "--quiet"]);
      }),
    });
    const reconciledHead = git(worktree.path, ["rev-parse", "HEAD"]).trim();

    const result = await reconciler(handoffId);

    expect(result.status).toBe("typecheck_failed");
    expect(hasCommit(repoB, reconciledHead)).toBe(false);
    expect(verdicts[0]?.head_sha).toBe(git(repoB, ["rev-parse", worktree.branchName]).trim());
    expect(verdicts[0]?.typecheck).toBe("fail");
    expect(verdicts[0]?.files_changed).toBe(2);
  });

  test("runs the test baseline in a provisioned scratch worktree of the project repo", async () => {
    seedTestStageProject("lockfile v1\n");
    const baselineRuns: BaselineRun[] = [];
    const reconciler = await setup(null, {
      change: "package",
      runCommand: testStageCommands(baselineRuns),
    });
    const scratchPath = join(tmp, "scratch", "test-baseline", handoffId);
    git(repoB, ["worktree", "add", "--detach", scratchPath, "main"]);

    const result = await reconciler(handoffId);

    expect(result.status).toBe("verified");
    expect(verdicts[0]?.tests).toBe("pass");
    expect(baselineRuns).toEqual([
      {
        cwd: scratchPath,
        localCache: "project-b cache\n",
        sharedDependency: join(tmp, "shared"),
      },
    ]);
    expect(readFileSync(join(worktree.path, "local_cache", "marker"), "utf8")).toBe(
      "project-b cache\n",
    );
    expect(registeredWorktrees(repoB)).not.toContain(scratchPath);
  });

  test("keys the test baseline cache by project repo", async () => {
    seedTestStageProject("lockfile v1\n");
    git(tmp, ["clone", "--quiet", repoB, repoC]);
    git(repoC, ["config", "user.email", "test@test.com"]);
    git(repoC, ["config", "user.name", "test"]);
    const baselineRuns: BaselineRun[] = [];
    const reconcileB = await setup(null, {
      change: "package",
      runCommand: testStageCommands(baselineRuns),
    });
    const reconcileC = await setup(null, {
      change: "package",
      handoffId: "h-pr-219-c",
      projectId: "proj-c",
      runCommand: testStageCommands(baselineRuns),
    });

    expect((await reconcileB(handoffId)).status).toBe("verified");
    expect((await reconcileC("h-pr-219-c")).status).toBe("verified");

    expect(baselineRuns.map((run) => run.cwd)).toEqual([
      join(tmp, "scratch", "test-baseline", handoffId),
      join(tmp, "scratch", "test-baseline", "h-pr-219-c"),
    ]);
  });

  test("keys the test baseline cache by the project repo lockfile at the merge base", async () => {
    seedTestStageProject("lockfile v1\n");
    const baselineRuns: BaselineRun[] = [];
    const reconciler = await setup(null, {
      change: "package",
      runCommand: testStageCommands(baselineRuns),
    });
    expect((await reconciler(handoffId)).status).toBe("verified");
    writeFileSync(join(repoB, "bun.lock"), "lockfile v2\n");
    git(repoB, ["add", "bun.lock"]);
    git(repoB, ["commit", "-m", "bump lockfile"]);

    expect((await reconciler(handoffId)).status).toBe("verified");

    expect(baselineRuns).toHaveLength(1);
  });

  test("keys the test baseline cache by the project repo lockfile when the merge base has none", async () => {
    seedTestStageProject(null);
    writeFileSync(join(repoB, "bun.lock"), "lockfile v1\n");
    const baselineRuns: BaselineRun[] = [];
    const reconciler = await setup(null, {
      change: "package",
      runCommand: testStageCommands(baselineRuns),
    });
    expect((await reconciler(handoffId)).status).toBe("verified");
    writeFileSync(join(repoB, "bun.lock"), "lockfile v2\n");

    expect((await reconciler(handoffId)).status).toBe("verified");

    expect(baselineRuns).toHaveLength(2);
  });

  test("resolves a branch_base that exists only as origin/<base> in the project repo", async () => {
    git(repoB, ["branch", "feature/remote-only", "feature/only-in-b"]);
    git(repoB, ["update-ref", "refs/remotes/origin/feature/remote-only", "feature/remote-only"]);
    const reconciler = await setup("feature/remote-only");
    git(repoB, ["branch", "-D", "feature/remote-only"]);

    const outcome = await reconciler(handoffId).then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, error: String(err) }),
    );

    expect(outcome).toMatchObject({ ok: true, result: { status: "verified" } });
    expect(verdicts[0]?.base_sha).toBe(
      git(repoB, ["rev-parse", "origin/feature/remote-only"]).trim(),
    );
  });

  test("prefers the local branch_base over origin/<base>", async () => {
    git(repoB, ["update-ref", "refs/remotes/origin/feature/only-in-b", "main"]);
    const reconciler = await setup("feature/only-in-b");

    const outcome = await reconciler(handoffId).then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, error: String(err) }),
    );

    expect(outcome).toMatchObject({ ok: true, result: { status: "verified" } });
    const repoBMain = git(repoB, ["rev-parse", "main"]).trim();
    const expected = git(repoB, ["rev-parse", "feature/only-in-b"]).trim();
    expect(verdicts[0]?.base_sha).toBe(expected);
    expect(verdicts[0]?.base_sha).not.toBe(repoBMain);
  });

  test("returns a typed invalid_branch_base when branch_base resolves neither locally nor on origin", async () => {
    git(repoB, ["branch", "feature/gone", "main"]);
    const reconciler = await setup("feature/gone");
    git(repoB, ["branch", "-D", "feature/gone"]);

    const outcome = await reconciler(handoffId).then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, error: String(err) }),
    );

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        status: "test_failed",
        error_code: "invalid_branch_base",
        verification_environment_error: true,
      },
    });
    if (!outcome.ok) throw new Error(`expected a typed result, got throw: ${outcome.error}`);
    expect(JSON.parse(outcome.result.regression_summary ?? "{}")).toMatchObject({
      code: "invalid_branch_base",
      field: "branch_base",
      value: "feature/gone",
      reason: "unresolvable",
    });
    expect(verdicts).toEqual([]);
  });
});
