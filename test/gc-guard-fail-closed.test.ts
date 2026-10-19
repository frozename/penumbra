import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("delete intent belongs to one simple command", () => {
  const victim = "agent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let repo = "";
  let sha = "";

  beforeAll(() => {
    repo = mkRepo();
    mkUnlandedBranch(repo, victim);
    const revParse = Bun.spawnSync({ cmd: ["git", "rev-parse", victim], cwd: repo });
    sha = revParse.stdout.toString().trim();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const expand = (command: string): string =>
    command.replaceAll("SHA", sha).replaceAll("VICTIM", victim);

  test.each([
    ["branch create; tr -d", "git branch wp/55 SHA; git log --oneline | wc -l | tr -d ' '"],
    ["branch create && cut -d:", "git branch wp/55 SHA && git ls-remote origin | cut -d: -f1"],
    ["branch create; sort -d", "git branch wp/55 SHA; ls | sort -d"],
    [
      "branch create; push; tr -d",
      "git branch wp/55 SHA; git push -u origin wp/55 2>&1 | tail -1; git ls-remote origin | wc -l | tr -d ' '",
    ],
    [
      "branch create && push && cut -d :",
      "git branch wp/55 SHA && git push -u origin wp/55 && git ls-remote origin | cut -d : -f1",
    ],
    [
      "branch create; push; sort -d",
      "git branch wp/55 SHA; git push -u origin wp/55; git branch | sort -d | head -5",
    ],
    [
      "branch create; push; quoted ' :' word",
      "git branch wp/55 SHA; git push -u origin wp/55; echo 'remote :done'",
    ],
    ["push && tr -d", "git push -u origin wp/55 && git log --oneline | wc -l | tr -d ' '"],
    ["newline-separated branch create and tr -d", "git branch wp/55 SHA\ntr -d ' ' < /dev/null"],
    [
      "newline-separated branch create, push and cut -d :",
      "git branch wp/55 SHA\ngit push -u origin wp/55\ngit ls-remote origin | cut -d : -f1",
    ],
    [
      "heredoc message with an apostrophe, push and tr -d",
      "git commit -m \"$(cat <<'EOF'\nDon't break the branch -d path\nEOF\n)\" && git push -u origin wp/55 && git log --oneline | wc -l | tr -d ' '",
    ],
  ])("%s is allowed", (_label, command) => {
    expect(runGuard(repo, expand(command))).toBe(0);
  });

  test.each([
    ["branch -D", "git branch -D VICTIM"],
    ["branch -d && echo", "git branch -d VICTIM && echo ok"],
    ["echo; branch -D", "echo ok; git branch -D VICTIM"],
    ["branch create; branch -D", "git branch wp/55 SHA; git branch -D VICTIM"],
    ["push colon-ref", "git push origin :VICTIM"],
    ["push --delete", "git push origin --delete VICTIM"],
    ["push -d", "git push origin -d VICTIM"],
    ["push && push colon-ref", "git push -u origin wp/55 && git push origin :VICTIM"],
    ["push, newline, push colon-ref", "git push -u origin wp/55\ngit push origin :VICTIM"],
    ["quoted colon-ref", "git push origin ':VICTIM'"],
    ["quoted separator before -D", "git branch 'x|y' -D VICTIM"],
    ["branch -D inside $(...)", 'echo "$(git branch -D VICTIM)"'],
    ["branch -D in a heredoc fed to a shell", "bash <<'EOF'\ngit branch -D VICTIM\nEOF"],
  ])("%s on an unlanded branch is blocked", (_label, command) => {
    expect(runGuard(repo, expand(command))).toBe(2);
  });

  test("git -C <repo> push colon-ref on an unlanded branch is blocked", () => {
    expect(runGuard(repo, `git -C ${repo} push origin :${victim}`)).toBe(2);
  });
});
