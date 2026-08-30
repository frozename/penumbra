import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectScope } from "@src/identity/project-resolver.js";
import { ProjectRegistry } from "@src/projects/registry.js";

let dir = "";

function mkGitDir(): void {
  dir = mkdtempSync(join(tmpdir(), "penumbra-project-resolver-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", "https://example.com/foo/bar.git"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "#\n");
}

beforeEach(() => {
  mkGitDir();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("registered repo_root returns kind=registered with friendly name", () => {
  const gitRoot = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  const registry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: gitRoot || dir }]]),
  );
  const scope = resolveProjectScope({ cwd: dir, registry });
  expect(scope.kind).toBe("registered");
  if (scope.kind === "registered") {
    expect(scope.project_id).toBe("penumbra");
  }
});

test("git repo with no registry match returns kind=no_match", () => {
  const scope = resolveProjectScope({ cwd: dir, registry: new ProjectRegistry(new Map()) });
  expect(scope.kind).toBe("no_match");
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("non-git cwd returns kind=global with null project_id", () => {
  const nonGit = mkdtempSync(join(tmpdir(), "penumbra-project-resolver-non-git-"));
  try {
    const scope = resolveProjectScope({ cwd: nonGit });
    expect(scope.kind).toBe("global");
    expect(scope.project_id).toBeNull();
    expect(scope.repo_root).toBeNull();
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test("registry.list() returning empty array returns kind=no_match", () => {
  const registry = {
    list: mock(() => {
      return [];
    }),
  };
  const scope = resolveProjectScope({ cwd: dir, registry });
  expect(scope.kind).toBe("no_match");
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("registry.list() throwing returns kind=registry_unavailable", () => {
  const registry = {
    list: mock(() => {
      throw new Error("boom");
    }),
  };
  const scope = resolveProjectScope({ cwd: dir, registry });
  expect(scope.kind).toBe("registry_unavailable");
  if (scope.kind === "registry_unavailable") {
    expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
  }
});

test("registry undefined defaults to no_match for git repos", () => {
  const scope = resolveProjectScope({ cwd: dir, registry: undefined });
  expect(scope.kind).toBe("no_match");
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("marker-resolved project finds registered name from subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-project-resolver-marker-"));
  try {
    const subDir = join(root, "sub", "dir");
    mkdirSync(subDir, { recursive: true });
    const projectId = "9f1b5c6f2a8d4e3c1d0f7a9b8c1234567";
    const markerPath = join(root, ".penumbra-project");
    writeFileSync(markerPath, `${projectId}\n`);

    const registry = new ProjectRegistry(
      new Map([[projectId, { project_id: projectId, root_path: root }]]),
    );

    const scope = resolveProjectScope({ cwd: subDir, registry });
    expect(scope.kind).toBe("registered");
    if (scope.kind === "registered") {
      expect(scope.project_id).toBe(projectId);
      expect(scope.repo_root).toBe(root);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
