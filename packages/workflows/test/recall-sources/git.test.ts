import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidGitRef, runGitDiff, runGitLog, runGitShow } from "@src/recall-sources/git.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execSync('git add a.txt && git commit -q -m "first commit"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  execSync('git add a.txt && git commit -q -m "second commit"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("git.log returns commit log lines", async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).toContain("second commit");
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff returns unified diff", async () => {
  const dir = initRepo();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).toContain("+two");
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.log on bad range returns warning, not throw", async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: "no-such-ref" } });
    expect(out.text).toBe("");
    expect(out.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isValidGitRef accepts safe refs and ranges", () => {
  const valid = [
    "HEAD",
    "main",
    "feature/foo",
    "abc123def",
    "HEAD~3..HEAD",
    "main...feature/x",
    "v1.2.3",
  ];
  for (const ref of valid) {
    expect(isValidGitRef(ref)).toBe(true);
  }
});

test("isValidGitRef rejects option-like or unsafe refs", () => {
  const invalid = [
    "--exec=touch /tmp/pwned",
    "; rm -rf /",
    "bad\nref",
    "bad'ref",
    "-main",
    "--",
    `bad${String.fromCharCode(0)}ref`,
  ];
  for (const ref of invalid) {
    expect(isValidGitRef(ref)).toBe(false);
  }
});

test("git sources reject invalid refs without executing git", async () => {
  const dir = initRepo();
  try {
    const range = "--exec=touch /tmp/pwned";
    const logOut = await runGitLog({ cwd: dir, args: { range } });
    expect(logOut.text).toBe("");
    expect(logOut.warnings).toEqual(["git.log: invalid ref"]);

    const diffOut = await runGitDiff({ cwd: dir, args: { range } });
    expect(diffOut.text).toBe("");
    expect(diffOut.warnings).toEqual(["git.diff: invalid ref"]);

    const showOut = await runGitShow({ cwd: dir, args: { range } });
    expect(showOut.commits).toEqual([]);
    expect(showOut.warnings).toEqual(["git.show: invalid ref"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.log rejects unsafe format strings", async () => {
  const dir = initRepo();
  try {
    const nulFormat = await runGitLog({ cwd: dir, args: { format: "%x00" } });
    expect(nulFormat.text).toBe("");
    expect(nulFormat.warnings).toEqual(["git.log: invalid format"]);

    const literalNulFormat = await runGitLog({
      cwd: dir,
      args: { format: `bad${String.fromCharCode(0)}fmt` },
    });
    expect(literalNulFormat.text).toBe("");
    expect(literalNulFormat.warnings).toEqual(["git.log: invalid format"]);

    const directiveFormat = await runGitLog({ cwd: dir, args: { format: "%(trailers)" } });
    expect(directiveFormat.text).toBe("");
    expect(directiveFormat.warnings).toEqual(["git.log: invalid format"]);

    const defaultFormat = await runGitLog({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(defaultFormat.text).toContain("second commit");
    expect(defaultFormat.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
