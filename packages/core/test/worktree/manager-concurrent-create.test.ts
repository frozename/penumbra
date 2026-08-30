import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { type WorktreeCommandRunner, WorktreeManager } from "../../src/worktree/manager.js";

type ExecResult = { stdout: string; stderr: string };
type ExecOpts = { cwd?: string };
const exec: (command: string, opts?: ExecOpts) => Promise<ExecResult> = promisify(execCb);

async function expectRejectsWith(
  promise: Promise<unknown>,
  matcher: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (matcher instanceof RegExp) {
      expect(message).toMatch(matcher);
    } else {
      expect(message).toContain(matcher);
    }
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

async function setupTempRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await exec(`git init -b main`, { cwd: repoDir });
  await exec(`git config user.email "test@example.com"`, { cwd: repoDir });
  await exec(`git config user.name "test"`, { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await exec(`git add . && git commit -m "init"`, { cwd: repoDir });
  return repoDir;
}

describe("WorktreeManager.createWorktree — concurrent TOCTOU guard", () => {
  let homeRoot: string;
  let homeRepo: string;
  let originalWorktreeRoot: string | undefined;

  beforeEach(async () => {
    originalWorktreeRoot = process.env.PENUMBRA_WORKTREE_ROOT;
    delete process.env.PENUMBRA_WORKTREE_ROOT;
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-concurrent-"));
    homeRepo = await setupTempRepo("penumbra-wt-concrepo-");
  });

  afterEach(() => {
    if (originalWorktreeRoot === undefined) {
      delete process.env.PENUMBRA_WORKTREE_ROOT;
    } else {
      process.env.PENUMBRA_WORKTREE_ROOT = originalWorktreeRoot;
    }
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(homeRepo, { recursive: true, force: true });
    fs.rmSync(`${homeRepo}-worktrees`, { recursive: true, force: true });
  });

  it("loser's createWorktree rejects without deleting the winner's worktree or marker file", async () => {
    // Both managers constructed BEFORE any worktree exists on disk. This
    // mirrors the real two-worker race: neither's rediscoverWorktrees()
    // sees anything, so each has() check independently misses.
    const winner = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
    const loser = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });

    const handoffId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const winnerHandle = await winner.createWorktree(handoffId);
    expect(fs.existsSync(winnerHandle.path)).toBe(true);
    expect(fs.existsSync(path.join(winnerHandle.path, ".git"))).toBe(true);

    // Marker file simulates in-progress work at the winner's worktree.
    const marker = path.join(winnerHandle.path, "winner-marker.txt");
    fs.writeFileSync(marker, "winner-in-progress\n");

    await expectRejectsWith(loser.createWorktree(handoffId), /worktree_path_exists/);

    // Winner's directory, marker, and .git registration must survive.
    expect(fs.existsSync(winnerHandle.path)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("winner-in-progress\n");
    expect(fs.existsSync(path.join(winnerHandle.path, ".git"))).toBe(true);

    const branch = await exec(
      `git -C "${homeRepo}" rev-parse --verify --quiet "refs/heads/agent/${handoffId}"`,
    );
    expect(branch.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

    await winner.teardownWorktree(handoffId, true);
  });

  it("suffixes branch names when the requested branch already exists", async () => {
    const existingRefs = new Set(["refs/heads/feat/full-task-pool"]);
    const checkouts: string[] = [];
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the concurrent-worktree test runner fixture while grandfathering its pre-existing complexity.
    const runner: WorktreeCommandRunner = (_cmd, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        const wtPath = args[3];
        if (!wtPath) throw new Error("missing worktree path");
        fs.mkdirSync(wtPath, { recursive: true });
        fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: fake\n");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[2]) {
        if (existingRefs.has(args[2])) return { stdout: "sha\n", stderr: "" };
        throw new Error(`missing ref ${args[2]}`);
      }
      if (args[0] === "-C" && args[2] === "checkout" && args[3] === "-b" && args[4]) {
        checkouts.push(args[4]);
        existingRefs.add(`refs/heads/${args[4]}`);
        return { stdout: "", stderr: "" };
      }
      if (
        args[0] === "-C" &&
        args[2] === "checkout" &&
        args[3] === "--" &&
        args[4] === "bun.lock"
      ) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        throw new Error("not a worktree");
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner,
      resolveBranchName: (): string => "feat/full-task-pool",
    });

    const handle1 = await manager.createWorktree("handoff-a");
    const handle2 = await manager.createWorktree("handoff-b");

    expect(handle1.branchName).toBe("feat/full-task-pool-2");
    expect(handle2.branchName).toBe("feat/full-task-pool-3");
    expect(checkouts).toEqual(["feat/full-task-pool-2", "feat/full-task-pool-3"]);
  });

  it("retries the next suffix when checkout loses a branch-name race", async () => {
    const existingRefs = new Set<string>();
    const checkouts: string[] = [];
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the concurrent-worktree test runner fixture while grandfathering its pre-existing complexity.
    const runner: WorktreeCommandRunner = (_cmd, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        const wtPath = args[3];
        if (!wtPath) throw new Error("missing worktree path");
        fs.mkdirSync(wtPath, { recursive: true });
        fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: fake\n");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[2]) {
        if (existingRefs.has(args[2])) return { stdout: "sha\n", stderr: "" };
        throw new Error(`missing ref ${args[2]}`);
      }
      if (args[0] === "-C" && args[2] === "checkout" && args[3] === "-b" && args[4]) {
        checkouts.push(args[4]);
        if (args[4] === "feat/x") {
          existingRefs.add("refs/heads/feat/x");
          throw new Error("fatal: a branch named 'feat/x' already exists");
        }
        existingRefs.add(`refs/heads/${args[4]}`);
        return { stdout: "", stderr: "" };
      }
      if (
        args[0] === "-C" &&
        args[2] === "checkout" &&
        args[3] === "--" &&
        args[4] === "bun.lock"
      ) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        throw new Error("not a worktree");
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner,
      resolveBranchName: (): string => "feat/x",
    });

    const handle = await manager.createWorktree("handoff-race");

    expect(handle.branchName).toBe("feat/x-2");
    expect(checkouts).toEqual(["feat/x", "feat/x-2"]);
  });

  it("rediscovers the actual checked-out branch and reports stored-name drift", () => {
    const handoffId = "handoff-drift";
    const wtPath = path.join(homeRoot, handoffId);
    const gitDir = path.join(homeRoot, ".git", "worktrees", handoffId);
    const drift: { handoffId: string; actual: string; stored: string }[] = [];
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, ".git"), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feat/full-task-pool-2\n");

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      resolveBranchName: (): string => "feat/full-task-pool",
      onBranchNameDrift: (id, actual, stored): void => {
        drift.push({ handoffId: id, actual, stored });
      },
    });
    const handle = manager.getWorktree(handoffId);

    expect(handle?.branchName).toBe("feat/full-task-pool-2");
    expect(drift).toEqual([
      {
        handoffId,
        actual: "feat/full-task-pool-2",
        stored: "feat/full-task-pool",
      },
    ]);
  });
});
