import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { WorktreeManager } from "../../src/worktree/manager.js";

const exec = promisify(execCb);

async function setupTempRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await exec(`git init -b main`, { cwd: repoDir });
  await exec(`git config user.email "test@example.com"`, { cwd: repoDir });
  await exec(`git config user.name "test"`, { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await exec(`git add . && git commit -m "init"`, { cwd: repoDir });
  return repoDir;
}

describe("WorktreeManager — project parameterization", () => {
  let homeRoot: string;
  let homeRepo: string;
  let counter = 0;

  beforeEach(async () => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-home-"));
    homeRepo = await setupTempRepo("penumbra-wt-homerepo-");
  });

  afterEach(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(homeRepo, { recursive: true, force: true });
  });

  function nextHandoff(): string {
    return `wt-test-${Date.now()}-${++counter}`;
  }

  it("creates and tears down under home base when no project_id provided", async () => {
    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id);

    expect(handle.path).toBe(path.join(homeRoot, id));
    expect(handle.projectId).toBeUndefined();
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(path.join(handle.path, ".git"))).toBe(true);

    await manager.teardownWorktree(id, true);
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(manager.getWorktree(id)).toBeNull();
  });

  it("passes explicit baseRef through to git worktree add", async () => {
    fs.writeFileSync(path.join(homeRepo, "README.md"), "# base\n");
    await exec(`git add README.md && git commit -m "base"`, { cwd: homeRepo });
    fs.writeFileSync(path.join(homeRepo, "README.md"), "# tip\n");
    await exec(`git add README.md && git commit -m "tip"`, { cwd: homeRepo });

    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { baseRef: "HEAD~1" });

    expect(handle.path).toBe(path.join(homeRoot, id));
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.readFileSync(path.join(handle.path, "README.md"), "utf8")).toBe("# base\n");
    await manager.teardownWorktree(id, true);
  });

  it("creates and prunes under <project_root>-worktrees when project_id resolves", async () => {
    const siriusRepo = await setupTempRepo("penumbra-wt-sirius-");
    const expectedBase = `${siriusRepo}-worktrees`;

    try {
      const manager = new WorktreeManager({
        rootDir: homeRoot,
        mainRepoDir: homeRepo,
        resolveProjectRoot: (id) => (id === "sirius" ? siriusRepo : undefined),
      });

      const id = nextHandoff();
      const handle = await manager.createWorktree(id, { project_id: "sirius" });

      expect(handle.path).toBe(path.join(expectedBase, id));
      expect(handle.projectId).toBe("sirius");
      expect(fs.existsSync(handle.path)).toBe(true);
      // Must not have been created in the home base.
      expect(fs.existsSync(path.join(homeRoot, id))).toBe(false);

      // Prune via teardown — must clean up under the per-project base.
      await manager.teardownWorktree(id, true);
      expect(fs.existsSync(handle.path)).toBe(false);
      expect(manager.getWorktree(id, "sirius")).toBeNull();
    } finally {
      fs.rmSync(siriusRepo, { recursive: true, force: true });
      fs.rmSync(expectedBase, { recursive: true, force: true });
    }
  });

  it("throws unknown_project_id when project_id is set but resolver returns undefined", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      resolveProjectRoot: (id) => (id === "known" ? homeRepo : undefined),
    });
    const id = nextHandoff();
    await expect(manager.createWorktree(id, { project_id: "totally-bogus" })).rejects.toThrow(
      /unknown_project_id: totally-bogus/,
    );
    expect(manager.getWorktree(id)).toBeNull();
  });

  it("uses mainRepoDir and ignores project_id when no resolver is configured", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { project_id: "whatever" });
    expect(handle.path).toBe(path.join(homeRoot, id));
    await manager.teardownWorktree(id, true);
  });
});

describe("WorktreeManager.stageMergedBase", () => {
  let repoDir: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-stage-root-"));
    repoDir = await setupTempRepo("penumbra-stage-repo-");
  });

  afterEach(() => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  async function commitFile(name: string, content: string, message: string): Promise<string> {
    fs.writeFileSync(path.join(repoDir, name), content);
    await exec(`git add ${name} && git commit -m "${message}"`, { cwd: repoDir });
    const { stdout } = await exec(`git rev-parse HEAD`, { cwd: repoDir });
    return stdout.trim();
  }

  it("creates a synthetic merge stage that includes all ancestor trees", async () => {
    const a = await commitFile("a.txt", "A\n", "a");
    const b = await commitFile("b.txt", "B\n", "b");
    const c = await commitFile("c.txt", "C\n", "c");

    const manager = new WorktreeManager({ rootDir: worktreeRoot, mainRepoDir: repoDir });
    const stageRef = await manager.stageMergedBase("h1", [c, b, a]);

    expect(stageRef).toBe("stage/h1");
    const { stdout } = await exec(`git -C "${repoDir}" rev-parse "${stageRef}"`, { cwd: repoDir });
    expect(stdout.trim()).toBeDefined();
    const tree = await exec(`git -C "${repoDir}" ls-tree --name-only -r "${stageRef}"`, {
      cwd: repoDir,
    });
    expect(tree.stdout.trim().split("\n").sort()).toEqual(
      ["README.md", "a.txt", "b.txt", "c.txt"].sort(),
    );
    expect(fs.existsSync(path.join(worktreeRoot, ".stage-h1"))).toBe(false);
  });

  it("returns a single ref unchanged without creating a stage", async () => {
    const a = await commitFile("a.txt", "A\n", "a");

    const manager = new WorktreeManager({ rootDir: worktreeRoot, mainRepoDir: repoDir });
    const stageRef = await manager.stageMergedBase("h1", [a]);

    expect(stageRef).toBe(a);
    expect(fs.existsSync(path.join(worktreeRoot, ".stage-h1"))).toBe(false);
  });

  it("throws on an empty ancestor list", async () => {
    const manager = new WorktreeManager({ rootDir: worktreeRoot, mainRepoDir: repoDir });
    await expect(manager.stageMergedBase("h1", [])).rejects.toThrow(
      "stageMergedBase: empty ancestorRefs",
    );
  });

  it("surfaces merge conflicts from the scratch worktree", async () => {
    const base = await commitFile("shared.txt", "base\n", "base");
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "left\n");
    await exec(`git add shared.txt && git commit -m "left"`, { cwd: repoDir });
    const left = (await exec(`git rev-parse HEAD`, { cwd: repoDir })).stdout.trim();
    await exec(`git checkout ${base}`, { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "right\n");
    await exec(`git add shared.txt && git commit -m "right"`, { cwd: repoDir });
    const right = (await exec(`git rev-parse HEAD`, { cwd: repoDir })).stdout.trim();

    const manager = new WorktreeManager({ rootDir: worktreeRoot, mainRepoDir: repoDir });
    await expect(manager.stageMergedBase("h1", [left, right])).rejects.toThrow();
    expect(fs.existsSync(path.join(worktreeRoot, ".stage-h1"))).toBe(false);
  });
});
