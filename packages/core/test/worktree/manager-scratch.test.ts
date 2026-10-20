import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { type WorktreeCommandRunner, WorktreeManager } from "@src/worktree/manager.js";
import { readScratchOwner, scratchDirName } from "@src/worktree/scratch.js";

const execFile = promisify(execFileCb);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

const realRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });

// bun:test types `.rejects.toThrow(...)` as void — assert rejections by hand.
async function expectRejectsWith(
  promise: Promise<unknown>,
  matcher?: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (matcher === undefined) return;
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

describe("WorktreeManager scratch worktrees", () => {
  let repoDir: string;
  let base: string;
  let sha: string;
  let managerRoot: string;
  let manager: WorktreeManager;
  const runId = "run-1234-abcd";

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-scratch-repo-"));
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
    base = `${repoDir}-worktrees`;
    managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-other-"));
    manager = new WorktreeManager({ rootDir: managerRoot, mainRepoDir: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(managerRoot, { recursive: true, force: true });
  });

  test("createScratchWorktree makes a detached worktree at the requested sha with an owner marker", async () => {
    // A second commit gives HEAD a different sha than the requested base.
    fs.writeFileSync(path.join(repoDir, "b.txt"), "b\n");
    await git(repoDir, ["add", "b.txt"]);
    await git(repoDir, ["commit", "-m", "second"]);

    const { path: wtPath } = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });

    expect(wtPath).toBe(path.join(base, scratchDirName(runId)));
    expect(fs.existsSync(wtPath)).toBe(true);
    // Detached HEAD at the first commit — b.txt must not exist.
    expect(fs.existsSync(path.join(wtPath, "b.txt"))).toBe(false);
    const headSha = await git(wtPath, ["rev-parse", "HEAD"]);
    expect(headSha).toBe(sha);
    // Detached: symbolic-ref fails.
    await expectRejectsWith(git(wtPath, ["symbolic-ref", "HEAD"]));
    // Owner marker lands in the per-worktree git dir.
    const owner = readScratchOwner(wtPath);
    expect(owner?.owner_run_id).toBe(runId);
    expect(owner?.sha).toBe(sha);
    // bun auto-install guard.
    expect(fs.existsSync(path.join(wtPath, "node_modules"))).toBe(true);
    // No branch was created for the scratch.
    const branches = await git(repoDir, ["branch", "--list"]);
    expect(branches).not.toContain(runId);
  });

  test("createScratchWorktree leaves parent config, refs and the scratch checkout untouched", async () => {
    const headsBefore = await git(repoDir, ["for-each-ref", "refs/heads"]);
    const { path: wtPath } = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });
    // extensions.worktreeConfig is a repo-wide format flip a handoff lane
    // needs for per-worktree identity — a scratch has no identity writes, so
    // the parent repo's config must stay untouched.
    await expectRejectsWith(
      git(repoDir, ["config", "--get", "--local", "extensions.worktreeConfig"]),
    );
    // The empty node_modules auto-install guard is invisible to git status.
    expect(await git(wtPath, ["status", "--porcelain"])).toBe("");
    // Detached scratch creation must not create or move any branch.
    expect(await git(repoDir, ["for-each-ref", "refs/heads"])).toBe(headsBefore);
  });

  test("createScratchWorktree throws worktree_path_exists without destroying the occupant", async () => {
    const first = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });
    await expectRejectsWith(
      manager.createScratchWorktree({ owner_run_id: runId, repoRoot: repoDir, sha }),
      "worktree_path_exists",
    );
    expect(fs.existsSync(first.path)).toBe(true);
  });

  test("a .scratch-* dir under the fleet base is not rediscovered as a handoff worktree", async () => {
    await manager.createScratchWorktree({ owner_run_id: runId, repoRoot: repoDir, sha });
    // A fresh manager pointed at the same fleet base would rediscover entries.
    const rediscovering = new WorktreeManager({ rootDir: base, mainRepoDir: repoDir });
    expect(rediscovering.listWorktrees().map((h) => h.handoffId)).toEqual([]);
  });

  test("removeScratchWorktree removes the dir and its worktree registration", async () => {
    const { path: wtPath } = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });
    await manager.removeScratchWorktree({ path: wtPath, repoRoot: repoDir });
    expect(fs.existsSync(wtPath)).toBe(false);
    const listed = await git(repoDir, ["worktree", "list", "--porcelain"]);
    expect(listed).not.toContain(wtPath);
  });

  test("removeScratchWorktree handles a half-registered directory", async () => {
    const wtPath = path.join(base, scratchDirName("run-torn-1"));
    fs.mkdirSync(wtPath, { recursive: true });
    await manager.removeScratchWorktree({ path: wtPath, repoRoot: repoDir });
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  test("removeScratchWorktree falls back to fs removal when the git remove fails", async () => {
    const { path: wtPath } = await manager.createScratchWorktree({
      owner_run_id: runId,
      repoRoot: repoDir,
      sha,
    });
    const failingRunner: WorktreeCommandRunner = (cmd, args, opts) => {
      if (cmd === "git" && (args[0] === "worktree" || args.includes("worktree"))) {
        return Promise.reject(new Error("synthetic git failure"));
      }
      return realRunner(cmd, args, opts);
    };
    const failing = new WorktreeManager({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-failroot-")),
      mainRepoDir: repoDir,
      runner: failingRunner,
    });
    await failing.removeScratchWorktree({ path: wtPath, repoRoot: repoDir });
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});
