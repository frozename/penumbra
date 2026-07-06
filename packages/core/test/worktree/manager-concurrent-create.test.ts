import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorktreeManager } from "../../src/worktree/manager.js";

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
});
