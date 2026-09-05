import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GUARD = resolve(import.meta.dir, "../docs/cc-setup/hooks/penumbra-agent-gc-guard.sh");

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-guard-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ]) {
    Bun.spawnSync({ cmd: ["git", ...args], cwd: dir });
  }
  return dir;
}

function mkUnlandedBranch(repo: string, branch: string): void {
  Bun.spawnSync({ cmd: ["git", "checkout", "-q", "-b", branch], cwd: repo });
  writeFileSync(join(repo, "unlanded.txt"), "unlanded\n");
  Bun.spawnSync({ cmd: ["git", "add", "unlanded.txt"], cwd: repo });
  Bun.spawnSync({ cmd: ["git", "commit", "-q", "-m", "unlanded"], cwd: repo });
  Bun.spawnSync({ cmd: ["git", "checkout", "-q", "main"], cwd: repo });
}

function mkLandedBranch(repo: string, branch: string): void {
  Bun.spawnSync({ cmd: ["git", "branch", branch], cwd: repo });
}

function mkWorktree(repo: string, branch: string): string {
  const wt = mkdtempSync(join(tmpdir(), "gc-guard-wt-"));
  Bun.spawnSync({ cmd: ["git", "worktree", "add", "-q", wt, branch], cwd: repo });
  return wt;
}

function runGuard(repo: string, command: string, extraEnv: Record<string, string> = {}): number {
  const payload = JSON.stringify({ tool_input: { command }, cwd: repo });
  const result = Bun.spawnSync({
    cmd: ["bash", GUARD],
    cwd: repo,
    env: {
      ...process.env,
      PENUMBRA_DB: "/tmp/nonexistent-penumbra-db.sqlite",
      PENUMBRA_ALLOW_AGENT_GC_SENTINEL: "/tmp/nonexistent-penumbra-sentinel",
      ...extraEnv,
    },
    stdin: Buffer.from(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode;
}

test("bare git branch -D on unlanded fleet branch is blocked", () => {
  const repo = mkRepo();
  try {
    const branch = "agent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkUnlandedBranch(repo, branch);
    expect(runGuard(repo, `git branch -D ${branch}`)).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("xargs pipeline form is blocked when no explicit ref is enumerable", () => {
  const repo = mkRepo();
  try {
    mkUnlandedBranch(repo, "bulk-delete-me");
    expect(runGuard(repo, "git branch | xargs git branch -D")).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("for-loop form is blocked when no explicit ref is enumerable", () => {
  const repo = mkRepo();
  try {
    mkUnlandedBranch(repo, "bulk-delete-me");
    expect(runGuard(repo, 'for b in $(git branch); do git branch -D "$b"; done')).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("non-fleet branch with unlanded commits is protected", () => {
  const repo = mkRepo();
  try {
    mkUnlandedBranch(repo, "npm-publish-prep");
    expect(runGuard(repo, "git branch -D npm-publish-prep")).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("non-fleet branch with a live worktree and unlanded commits is protected", () => {
  const repo = mkRepo();
  let wt: string | undefined;
  try {
    const branch = "npm-publish-prep";
    mkUnlandedBranch(repo, branch);
    wt = mkWorktree(repo, branch);
    expect(runGuard(repo, `git branch -D ${branch}`)).toBe(2);
  } finally {
    if (wt) {
      Bun.spawnSync({ cmd: ["git", "worktree", "remove", "--force", wt], cwd: repo });
      rmSync(wt, { recursive: true, force: true });
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("genuinely landed ref is still permitted", () => {
  const repo = mkRepo();
  try {
    mkLandedBranch(repo, "landed");
    expect(runGuard(repo, "git branch -D landed")).toBe(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("override applied to one named ref still works", () => {
  const repo = mkRepo();
  try {
    mkUnlandedBranch(repo, "unlanded-override");
    expect(runGuard(repo, "PENUMBRA_ALLOW_AGENT_GC=1 git branch -D unlanded-override")).toBe(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("override on a multi-ref command does not permit the delete", () => {
  const repo = mkRepo();
  try {
    mkUnlandedBranch(repo, "bulk-delete-me");
    expect(
      runGuard(
        repo,
        'PENUMBRA_ALLOW_AGENT_GC=1 for b in $(git branch); do git branch -D "$b"; done',
      ),
    ).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
