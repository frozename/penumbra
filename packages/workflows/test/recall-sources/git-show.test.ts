import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGitShow } from "../../src/recall-sources/git.js";

function initRepoWithBodies(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-show-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });

  writeFileSync(join(dir, "a.txt"), "one\n");
  execSync(
    'git add a.txt && git commit -q -m "first commit" -m "first body line\nsecond body line"',
    { cwd: dir, shell: "/bin/bash" },
  );

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  execSync('git add a.txt && git commit -q -m "second commit" -m "second body"', {
    cwd: dir,
    shell: "/bin/bash",
  });

  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  execSync('git add a.txt && git commit -q -m "third commit" -m "third body"', {
    cwd: dir,
    shell: "/bin/bash",
  });

  return dir;
}

test("git.show returns two commits in range with parsed subjects/bodies", async () => {
  const dir = initRepoWithBodies();
  try {
    const out = await runGitShow({ cwd: dir, args: { range: "HEAD~2..HEAD" } });
    expect(out.warnings).toEqual([]);
    expect(out.commits).toHaveLength(2);

    const first = out.commits[0]!;
    const second = out.commits[1]!;
    expect(first.sha).toHaveLength(40);
    expect(second.sha).toHaveLength(40);
    expect(first.subject).toBe("third commit");
    expect(second.subject).toBe("second commit");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.body).toContain("third body");
    expect(second.body).toContain("second body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.show empty range returns no commits", async () => {
  const dir = initRepoWithBodies();
  try {
    const out = await runGitShow({ cwd: dir, args: { range: "HEAD..HEAD" } });
    expect(out.warnings).toEqual([]);
    expect(out.commits).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.show truncates oversized body with marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-show-long-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });

  writeFileSync(join(dir, "b.txt"), "content\n");
  const longBody = "x".repeat(2600);
  execSync(`git add b.txt && git commit -q -m "long body" -m "${longBody}"`, {
    cwd: dir,
    shell: "/bin/bash",
  });

  try {
    const out = await runGitShow({ cwd: dir, args: { range: "HEAD", max_commits: 1 } });
    expect(out.warnings).toEqual([]);
    expect(out.commits).toHaveLength(1);

    const body = out.commits[0]!.body;
    expect(body).toContain("[…truncated]");
    expect(body.length).toBeGreaterThan(2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.show on bad range returns warning, not throw", async () => {
  const dir = initRepoWithBodies();
  try {
    const out = await runGitShow({ cwd: dir, args: { range: "no-such-ref" } });
    expect(out.commits).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
