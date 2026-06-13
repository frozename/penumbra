import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { WorktreeManager } from "@penumbra/core";
import { RUN_AGENTCHAT_SERVICE_TESTS } from "../helpers/service-gates.js";

const exec = promisify(execCb);

function getWorkspaceDirs(mainRepoDir: string): string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(mainRepoDir, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const dirs = new Set<string>();

  for (const pattern of packageJson.workspaces ?? []) {
    const parentDir = pattern.split("*").at(0);
    if (!parentDir) continue;
    const workspaceParent = path.join(mainRepoDir, parentDir);
    if (!fs.existsSync(workspaceParent)) continue;
    for (const entry of fs.readdirSync(workspaceParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.add(path.join(parentDir, entry.name));
    }
  }

  return [...dirs];
}

describe.skipIf(!RUN_AGENTCHAT_SERVICE_TESTS)("WorktreeManager", () => {
  let rootDir: string;
  let mainRepoDir: string;
  let manager: WorktreeManager;
  let handoffCounter = 0;

  beforeEach(() => {
    // We use actual current directory as mainRepoDir so git worktree works.
    mainRepoDir = process.cwd();
    // Use a temp directory for worktrees
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-test-"));
    manager = new WorktreeManager({ rootDir, mainRepoDir });
  });

  afterEach(async () => {
    // Teardown any remaining worktrees
    const wts = manager.listWorktrees();
    for (const wt of wts) {
      await manager.teardownWorktree(wt.handoffId, true).catch(() => {});
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function getNextHandoffId() {
    return `test-handoff-${Date.now()}-${++handoffCounter}`;
  }

  it("creates worktree successfully", async () => {
    const handoffId = getNextHandoffId();
    const handle = await manager.createWorktree(handoffId);

    expect(handle.handoffId).toBe(handoffId);
    expect(handle.path).toBe(path.join(rootDir, handoffId));
    expect(handle.branchName).toBe(`agent/${handoffId}`);
    expect(handle.storageRoot).toBe(path.join(rootDir, handoffId, ".test-storage"));
    expect(handle.status).toBe("created");

    // Verify directories and files exist
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(handle.storageRoot)).toBe(true);

    // Verify symlinks
    const nodeModulesPath = path.join(handle.path, "node_modules");
    const bunLockPath = path.join(handle.path, "bun.lock");

    if (fs.existsSync(path.join(mainRepoDir, "node_modules"))) {
      expect(fs.lstatSync(nodeModulesPath).isSymbolicLink()).toBe(true);
    }
    if (fs.existsSync(path.join(mainRepoDir, "bun.lock"))) {
      expect(fs.lstatSync(bunLockPath).isFile()).toBe(true);
      expect(fs.lstatSync(bunLockPath).isSymbolicLink()).toBe(false);
    }

    // Verify branch exists inside worktree
    const { stdout } = await exec(`git -C "${handle.path}" branch --show-current`);
    expect(stdout.trim()).toBe(handle.branchName);
  });

  it("mirrors per-workspace node_modules so workspace deps resolve", async () => {
    const handoffId = getNextHandoffId();
    const handle = await manager.createWorktree(handoffId);

    const candidate = getWorkspaceDirs(mainRepoDir).find((relDir) =>
      fs.existsSync(path.join(mainRepoDir, relDir, "node_modules")),
    );
    if (!candidate) return;

    const wtPkgNm = path.join(handle.path, candidate, "node_modules");
    expect(fs.existsSync(wtPkgNm)).toBe(true);
    expect(fs.lstatSync(wtPkgNm).isSymbolicLink()).toBe(true);
  });

  it("gets worktree by handoff ID", async () => {
    const handoffId = getNextHandoffId();
    await manager.createWorktree(handoffId);

    const handle = manager.getWorktree(handoffId);
    expect(handle).not.toBeNull();
    expect(handle?.handoffId).toBe(handoffId);

    expect(manager.getWorktree("nonexistent")).toBeNull();
  });

  it("lists worktrees", async () => {
    const handoffId1 = getNextHandoffId();
    const handoffId2 = getNextHandoffId();

    await manager.createWorktree(handoffId1);
    await manager.createWorktree(handoffId2);

    const wts = manager.listWorktrees();
    expect(wts.length).toBe(2);
    expect(wts.find((w) => w.handoffId === handoffId1)).toBeDefined();
    expect(wts.find((w) => w.handoffId === handoffId2)).toBeDefined();
  });

  it("tears down worktree cleanly", async () => {
    const handoffId = getNextHandoffId();
    const handle = await manager.createWorktree(handoffId);

    await manager.teardownWorktree(handoffId);

    expect(manager.getWorktree(handoffId)).toBeNull();
    expect(fs.existsSync(handle.path)).toBe(false);

    // Verify branch is deleted
    try {
      await exec(`git show-ref --verify refs/heads/${handle.branchName}`);
      throw new Error("Branch should have been deleted");
    } catch (e: any) {
      expect(e.message).not.toMatch(/Branch should have been deleted/);
    }
  });

  it("tears down worktree with uncommitted changes when forced", async () => {
    const handoffId = getNextHandoffId();
    const handle = await manager.createWorktree(handoffId);

    // Create an uncommitted change
    fs.writeFileSync(path.join(handle.path, "uncommitted.txt"), "test data");

    // Without force, teardown should fail in git worktree remove
    let teardownFailed = false;
    try {
      await manager.teardownWorktree(handoffId, false);
    } catch (e) {
      teardownFailed = true;
    }
    // git worktree remove fails without force if it contains unstaged modifications
    expect(teardownFailed).toBe(true);

    // Force teardown should succeed
    await manager.teardownWorktree(handoffId, true);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  it("rediscover worktrees on restart", async () => {
    const handoffId = getNextHandoffId();
    const handle = await manager.createWorktree(handoffId);

    // Simulate restart by creating a new manager with the same rootDir
    const newManager = new WorktreeManager({ rootDir, mainRepoDir });

    const rediscovered = newManager.getWorktree(handoffId);
    expect(rediscovered).not.toBeNull();
    expect(rediscovered?.handoffId).toBe(handoffId);
    expect(rediscovered?.path).toBe(handle.path);
    expect(rediscovered?.branchName).toBe(handle.branchName);
    expect(rediscovered?.storageRoot).toBe(handle.storageRoot);
  });
});
