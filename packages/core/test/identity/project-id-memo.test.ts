import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createProjectIdResolver } from "@src/identity/project-id.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function initRepo(path: string, remote: string): void {
  spawnSync("git", ["init", "-q"], { cwd: path });
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: path });
}

function repoWithSub(remote: string): string {
  const root = mkdtempSync(join(tmpdir(), "penumbra-pid-memo-"));
  roots.push(root);
  initRepo(root, remote);
  const sub = join(root, "sub");
  mkdirSync(sub);
  return sub;
}

// A repo nested under a cached cwd leaves the outer repo's .git untouched, so
// the cheap validation cannot see it: only expiry or eviction surfaces it.
function nestRepo(sub: string): void {
  initRepo(sub, "https://example.com/nested/repo.git");
}

test("serves the cached resolution until the TTL expires", () => {
  let now = 0;
  const resolve = createProjectIdResolver({ ttlMs: 1_000, now: () => now });
  const sub = repoWithSub("https://example.com/outer/repo.git");
  const outer = resolve({ cwd: sub });
  expect(outer.project_id).toMatch(/:sub$/);

  nestRepo(sub);
  now = 999;
  expect(resolve({ cwd: sub })).toBe(outer);

  now = 1_000;
  const nested = resolve({ cwd: sub });
  expect(nested.kind).toBe("git");
  expect(nested.project_id).toMatch(/:\.$/);
  if (nested.kind === "git") expect(nested.git_remote).toBe("https://example.com/nested/repo.git");
});

test("evicts the least recently used cwd beyond maxEntries", () => {
  const resolve = createProjectIdResolver({ maxEntries: 2, now: () => 0 });
  const a = repoWithSub("https://example.com/a/repo.git");
  const b = repoWithSub("https://example.com/b/repo.git");
  const c = repoWithSub("https://example.com/c/repo.git");
  const first = resolve({ cwd: a });
  const second = resolve({ cwd: b });
  resolve({ cwd: a });
  resolve({ cwd: c });

  nestRepo(a);
  nestRepo(b);
  expect(resolve({ cwd: a })).toBe(first);
  expect(resolve({ cwd: b }).project_id).not.toBe(second.project_id);
});

test("keeps the entry across git commands that leave the origin config alone", () => {
  const resolve = createProjectIdResolver({ now: () => 0 });
  const sub = repoWithSub("https://example.com/outer/repo.git");
  const first = resolve({ cwd: sub });
  spawnSync("git", ["status"], { cwd: sub });
  expect(resolve({ cwd: sub })).toBe(first);
});

test("caches inside a linked worktree, whose .git is a pointer file", () => {
  const resolve = createProjectIdResolver({ now: () => 0 });
  const root = dirname(repoWithSub("https://example.com/wt/repo.git"));
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  spawnSync("git", [...identity, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const parent = mkdtempSync(join(tmpdir(), "penumbra-pid-memo-wt-"));
  roots.push(parent);
  const worktree = join(parent, "wt");
  spawnSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: root });
  const first = resolve({ cwd: worktree });
  expect(first.kind).toBe("git");
  expect(resolve({ cwd: worktree })).toBe(first);
});
