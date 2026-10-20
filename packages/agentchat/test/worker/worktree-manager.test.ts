import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorkerProjectRegistry } from "@src/worker/project-registry.js";
import { createWorkerWorktreeManager } from "@src/worker/worktree-manager.js";

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

describe("createWorkerWorktreeManager", () => {
  const originalEnv = process.env.PENUMBRA_PROJECTS_YAML;
  let tempRoot: string;
  let registryRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-worker-wtm-"));
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-worker-registry-"));
  });

  afterEach(() => {
    process.env.PENUMBRA_PROJECTS_YAML = originalEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(registryRoot, { recursive: true, force: true });
  });

  it("resolves sibling project roots from the project registry", () => {
    const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-worker-"));
    const projectsYaml = path.join(registryRoot, "projects.yaml");
    fs.writeFileSync(
      projectsYaml,
      ["projects:", "  - project_id: sibling", `    root_path: ${siblingRoot}`, ""].join("\n"),
    );

    const projectRegistry = new WorkerProjectRegistry(projectsYaml);
    const manager = createWorkerWorktreeManager({
      rootDir: tempRoot,
      mainRepoDir: process.cwd(),
      projectRegistry,
    });

    expect(
      (manager as unknown as { baseFor(project_id?: string): string }).baseFor("sibling"),
    ).toBe(`${siblingRoot}-worktrees`);
  });

  it("falls back to the default root when the registry is empty", () => {
    const projectRegistry = new WorkerProjectRegistry(
      path.join(registryRoot, "missing.yaml"),
      () => undefined,
    );
    const manager = createWorkerWorktreeManager({
      rootDir: tempRoot,
      mainRepoDir: process.cwd(),
      projectRegistry,
    });

    expect(
      (manager as unknown as { baseFor(project_id?: string): string }).baseFor("sibling"),
    ).toBe(tempRoot);
    expect(manager.projectRootFor("sibling")).toBeUndefined();
  });

  it("warns when the registry file is missing at construction", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {
      /* silence warn */
    });

    new WorkerProjectRegistry(path.join(registryRoot, "missing.yaml"));

    expect(warn).toHaveBeenCalled();
  });

  it("createWorktree falls through to the default root for a project_id while the registry is empty", async () => {
    const homeRepo = await setupTempRepo("penumbra-worker-homerepo-");
    try {
      const projectRegistry = new WorkerProjectRegistry(
        path.join(registryRoot, "missing.yaml"),
        () => undefined,
      );
      const manager = createWorkerWorktreeManager({
        rootDir: tempRoot,
        mainRepoDir: homeRepo,
        projectRegistry,
      });

      const handoffId = `wt-empty-registry-${String(Date.now())}`;
      const handle = await manager.createWorktree(handoffId, { project_id: "unconfigured" });

      expect(handle.path).toBe(path.join(tempRoot, handoffId));
      await manager.teardownWorktree(handoffId, true);
    } finally {
      fs.rmSync(homeRepo, { recursive: true, force: true });
    }
  });

  it("createWorktree throws unknown_project_id for an unlisted project once the registry has entries", async () => {
    const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-worker-"));
    const projectsYaml = path.join(registryRoot, "projects.yaml");
    fs.writeFileSync(
      projectsYaml,
      ["projects:", "  - project_id: sibling", `    root_path: ${siblingRoot}`, ""].join("\n"),
    );
    const projectRegistry = new WorkerProjectRegistry(projectsYaml);
    const manager = createWorkerWorktreeManager({
      rootDir: tempRoot,
      mainRepoDir: process.cwd(),
      projectRegistry,
    });

    const err = await manager
      .createWorktree(`wt-unknown-${String(Date.now())}`, { project_id: "bogus" })
      .catch((e: unknown) => e);
    expect(err instanceof Error && err.message.includes("unknown_project_id")).toBe(true);
  });

  it("resolves persisted handoff branch names from the injected cache", () => {
    const projectRegistry = new WorkerProjectRegistry(
      path.join(registryRoot, "missing.yaml"),
      () => undefined,
    );
    const manager = createWorkerWorktreeManager({
      rootDir: tempRoot,
      mainRepoDir: process.cwd(),
      projectRegistry,
      resolveBranchName: (handoffId) => (handoffId === "h1" ? "feat/full-task-pool" : undefined),
    });

    expect(
      (manager as unknown as { branchNameFor(handoffId: string): string }).branchNameFor("h1"),
    ).toBe("feat/full-task-pool");
    expect(
      (manager as unknown as { branchNameFor(handoffId: string): string }).branchNameFor("h2"),
    ).toBe("agent/h2");
  });
});
