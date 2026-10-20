import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectId } from "@src/identity/project-id.js";

let dir = "";

function initRepo(path: string, remote: string): void {
  spawnSync("git", ["init", "-q"], { cwd: path });
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: path });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-pid-git-"));
  initRepo(dir, "https://example.com/foo/bar.git");
  writeFileSync(join(dir, "README.md"), "#");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("resolves a git repo at the root to kind=git with deterministic id", () => {
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe("git");
  expect(r.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("resolves a subdirectory with relpath appended", () => {
  const sub = join(dir, "packages", "x");
  mkdirSync(sub, { recursive: true });
  const r = resolveProjectId({ cwd: sub });
  expect(r.kind).toBe("git");
  expect(r.project_id).toMatch(/:packages\/x$/);
});

test("two cwds in the same repo produce the same project-id prefix", () => {
  const a = resolveProjectId({ cwd: dir });
  mkdirSync(join(dir, "sub"));
  const b = resolveProjectId({ cwd: join(dir, "sub") });
  if (a.kind !== "git" || b.kind !== "git") throw new Error("expected git resolution");
  expect(a.project_id.split(":")[0]).toBe(b.project_id.split(":")[0]);
});

test("re-resolves after the origin remote changes in place", () => {
  const first = resolveProjectId({ cwd: dir });
  spawnSync("git", ["remote", "set-url", "origin", "https://example.com/changed/repo.git"], {
    cwd: dir,
  });
  const second = resolveProjectId({ cwd: dir });
  expect(second.kind).toBe("git");
  expect(second.project_id).not.toBe(first.project_id);
  if (second.kind === "git") expect(second.git_remote).toBe("https://example.com/changed/repo.git");
});

test("re-resolves a repo re-created at the same path with another remote", () => {
  const first = resolveProjectId({ cwd: dir });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  initRepo(dir, "https://example.com/other/repo.git");
  const second = resolveProjectId({ cwd: dir });
  expect(second.kind).toBe("git");
  expect(second.project_id).not.toBe(first.project_id);
});

test("follows a symlinked cwd to the repo it currently points at", () => {
  const other = mkdtempSync(join(tmpdir(), "penumbra-pid-git-other-"));
  const link = join(mkdtempSync(join(tmpdir(), "penumbra-pid-git-link-")), "cwd");
  try {
    initRepo(other, "https://example.com/other/repo.git");
    symlinkSync(dir, link);
    const viaFirst = resolveProjectId({ cwd: link });
    unlinkSync(link);
    symlinkSync(other, link);
    const viaSecond = resolveProjectId({ cwd: link });
    expect(viaSecond).toEqual(resolveProjectId({ cwd: other }));
    expect(viaSecond.project_id).not.toBe(viaFirst.project_id);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(join(link, ".."), { recursive: true, force: true });
  }
});

test("returns frozen git resolutions so callers cannot corrupt the shared result", () => {
  const first = resolveProjectId({ cwd: dir });
  expect(Object.isFrozen(first)).toBe(true);
  expect(() => {
    (first as { project_id: string }).project_id = "tampered";
  }).toThrow();
  expect(resolveProjectId({ cwd: dir }).project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("does not cache non-git resolution", () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), "penumbra-pid-non-git-"));
  try {
    const quarantined = resolveProjectId({ cwd: nonGitDir });
    expect(quarantined).toEqual({ kind: "quarantine", project_id: null });

    initRepo(nonGitDir, "https://example.com/foo/bar.git");
    const resolved = resolveProjectId({ cwd: nonGitDir });
    expect(resolved.kind).toBe("git");
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});
