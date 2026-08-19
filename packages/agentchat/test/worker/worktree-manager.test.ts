import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkerWorktreeManager } from "../../src/worker/worktree-manager.js";

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
    process.env.PENUMBRA_PROJECTS_YAML = projectsYaml;

    const manager = createWorkerWorktreeManager({ rootDir: tempRoot, mainRepoDir: process.cwd() });

    expect(
      (manager as unknown as { baseFor(project_id?: string): string }).baseFor("sibling"),
    ).toBe(`${siblingRoot}-worktrees`);
  });

  it("falls back to the default root when the registry is empty", () => {
    const projectsYaml = path.join(registryRoot, "projects.yaml");
    fs.writeFileSync(projectsYaml, "projects:\n");
    process.env.PENUMBRA_PROJECTS_YAML = projectsYaml;

    const manager = createWorkerWorktreeManager({ rootDir: tempRoot, mainRepoDir: process.cwd() });

    expect(
      (manager as unknown as { baseFor(project_id?: string): string }).baseFor("sibling"),
    ).toBe(tempRoot);
  });

  it("falls back to the default root when the registry path is invalid", () => {
    process.env.PENUMBRA_PROJECTS_YAML = path.join(registryRoot, "missing.yaml");
    const warn = spyOn(console, "warn").mockImplementation(() => {
      /* silence warn */
    });

    const manager = createWorkerWorktreeManager({ rootDir: tempRoot, mainRepoDir: process.cwd() });

    expect(
      (manager as unknown as { baseFor(project_id?: string): string }).baseFor("sibling"),
    ).toBe(tempRoot);
    expect(warn).toHaveBeenCalled();
  });

  it("resolves persisted handoff branch names from the injected cache", () => {
    const manager = createWorkerWorktreeManager({
      rootDir: tempRoot,
      mainRepoDir: process.cwd(),
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
