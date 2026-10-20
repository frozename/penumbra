import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitBlobSizes,
  isValidGitRef,
  runGitDiff,
  runGitLog,
  runGitShow,
} from "@src/recall-sources/git.js";
import { composeRecall } from "@src/recall.js";

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

test("git.diff renders NUL-bearing files as escaped text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  writeFileSync(
    join(dir, "bin.dat"),
    Buffer.concat([Buffer.from("start\nmid "), Buffer.from([0x00]), Buffer.from("dle\nend\n")]),
  );
  execSync('git add bin.dat && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(
    join(dir, "bin.dat"),
    Buffer.concat([
      Buffer.from("start\nmid "),
      Buffer.from([0x00]),
      Buffer.from("dle\nend changed\n"),
    ]),
  );
  execSync('git add bin.dat && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).not.toContain("Binary files");
    expect(out.text).toContain("mid \\0dle");
    expect(out.text).toContain("+end changed");
    expect(out.warnings).toEqual(["git.diff: 1 NUL bytes escaped"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initRepoWithBinaryBlob(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "code.ts"), "export const version = 1\n");
  execSync('git add code.ts && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  const blob = Buffer.alloc(200 * 1024);
  for (let i = 0; i < blob.length; i += 1) blob[i] = (i * 31 + 17) % 256;
  writeFileSync(join(dir, "blob.bin"), blob);
  writeFileSync(join(dir, "code.ts"), "export const version = 2\n");
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("git.diff keeps git's binary marker for dense-binary files instead of expanding them", async () => {
  const dir = initRepoWithBinaryBlob();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).toContain("+export const version = 2");
    expect(out.text).toContain("Binary files /dev/null and b/blob.bin differ");
    expect(out.text.length).toBeLessThan(4096);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff does not re-diff binary blobs over 1 MiB and keeps their markers", async () => {
  const dir = initRepo();
  try {
    writeFileSync(
      join(dir, "small.dat"),
      Buffer.concat([Buffer.from("start\nmid "), Buffer.from([0x00]), Buffer.from("dle\n")]),
    );
    const blob = Buffer.alloc(1200 * 1024);
    for (let i = 0; i < blob.length; i += 1) blob[i] = (i * 31 + 17) % 256;
    writeFileSync(join(dir, "huge.bin"), blob);
    execSync('git add . && git commit -q -m "v3"', { cwd: dir, shell: "/bin/bash" });

    const rediffed: string[] = [];
    const out = await runGitDiff(
      { cwd: dir, args: { range: "HEAD~1..HEAD" } },
      {
        rediffBinaryAsText: (pathspecs) => {
          rediffed.push(pathspecs.join(" "));
          return Promise.resolve("diff --git a/small.dat b/small.dat\n+rescued\n");
        },
      },
    );
    expect(rediffed).toHaveLength(1);
    expect(rediffed[0]).toContain("small.dat");
    expect(out.text).toContain("Binary files /dev/null and b/huge.bin differ");
    expect(out.text).toContain("+rescued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff caps binary re-diffs and bounds their concurrency", async () => {
  const dir = initRepo();
  try {
    for (let i = 0; i < 70; i += 1) {
      const buf = Buffer.alloc(64);
      buf[0] = 0;
      for (let j = 1; j < buf.length; j += 1) buf[j] = ((j * 37 + i) % 255) + 1;
      writeFileSync(join(dir, `bin${String(i).padStart(2, "0")}.bin`), buf);
    }
    execSync('git add . && git commit -q -m "v3"', { cwd: dir, shell: "/bin/bash" });

    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await runGitDiff(
      { cwd: dir, args: { range: "HEAD~1..HEAD" } },
      {
        rediffBinaryAsText: async (pathspecs) => {
          calls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          const path = pathspecs[pathspecs.length - 1]!.replace(":(top,literal)", "");
          return `diff --git a/${path} b/${path}\n+rescued\n`;
        },
      },
    );
    expect(calls).toBe(64);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(out.warnings.some((w) => w.includes("re-diff cap"))).toBe(true);
    expect((out.text.match(/Binary files/g) ?? []).length).toBe(70 - 64);
    expect(out.text).toContain("+rescued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initRepoWithManyBinaries(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  // Thousands of loose objects trip a detached auto-gc after commit, which
  // races the test's rmSync and leaves a partial fixture behind in TMPDIR.
  execSync("git config gc.auto 0", { cwd: dir });
  execSync("git config maintenance.auto false", { cwd: dir });
  const writeBinaries = (seed: number): void => {
    for (let i = 0; i < count; i += 1) {
      const buf = Buffer.alloc(64);
      buf[0] = 0;
      buf.writeUInt32LE(i, 1);
      buf.writeUInt32LE(seed, 5);
      for (let j = 9; j < buf.length; j += 1) buf[j] = ((j * 37 + i) % 255) + 1;
      writeFileSync(join(dir, `bin${String(i).padStart(5, "0")}.bin`), buf);
    }
  };
  writeBinaries(0);
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  writeBinaries(1);
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

const GIT_SOURCE_PATH = join(import.meta.dir, "../../src/recall-sources/git.ts");
const BUN_BIN = existsSync(join(homedir(), ".bun/bin/bun"))
  ? join(homedir(), ".bun/bin/bun")
  : process.execPath;

// cat-file --batch-check without --buffer flushes stdout per line; under bun
// each tiny chunk pins ~150 KB of native memory that GC never returns, so
// sizing thousands of blobs in one call blows the daemon's RSS. Measured on
// this test's fixture at ~2.1 GB without --buffer vs ~42 MB with it.
test("gitBlobSizes keeps RSS bounded when sizing thousands of blobs", async () => {
  const dir = initRepoWithManyBinaries(5000);
  try {
    const probePath = join(dir, "rss-probe.ts");
    writeFileSync(
      probePath,
      `import { execSync } from "node:child_process";
import { gitBlobSizes } from ${JSON.stringify(GIT_SOURCE_PATH)};
const repo = ${JSON.stringify(dir)};
const listing = execSync(
  "git ls-tree -r HEAD~1 --format='%(objectname)' && git ls-tree -r HEAD --format='%(objectname)'",
  { cwd: repo },
).toString();
const oids = listing.trim().split("\\n");
const sizes = await gitBlobSizes(repo, oids);
Bun.gc(true);
console.log(JSON.stringify({ rss: process.memoryUsage().rss, sized: sizes.size, oids: oids.length }));
`,
    );
    const proc = Bun.spawn({
      cmd: [BUN_BIN, probePath],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(stdout.trim()) as { rss: number; sized: number; oids: number };
    expect(report.oids).toBe(10_000);
    expect(report.sized).toBe(10_000);
    expect(report.rss).toBeLessThan(256 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// If cat-file exits before draining stdin (e.g. the cwd disappeared), the
// buffered write rejects with EPIPE; unobserved, that rejection would trip the
// daemon's unhandledRejection crash guard.
test("gitBlobSizes resolves without unhandled rejection when cat-file dies early", async () => {
  const oids = Array.from({ length: 80_000 }, (_, i) => `abc${String(i).padStart(7, "0")}`);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const sizes = await gitBlobSizes(join(tmpdir(), "penumbra-missing-cwd-xyz"), oids);
    expect(sizes.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rejections).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onRejection);
  }
});

test("git.diff stops sizing binary blobs once the re-diff cap is full", async () => {
  const dir = initRepo();
  try {
    for (let i = 0; i < 300; i += 1) {
      const buf = Buffer.alloc(64);
      buf[0] = 0;
      buf.writeUInt32LE(i, 1);
      for (let j = 5; j < buf.length; j += 1) buf[j] = ((j * 37 + i) % 255) + 1;
      writeFileSync(join(dir, `bin${String(i).padStart(3, "0")}.bin`), buf);
    }
    execSync('git add . && git commit -q -m "v3"', { cwd: dir, shell: "/bin/bash" });

    let sizeCalls = 0;
    let sizedOids = 0;
    let rediffCalls = 0;
    const out = await runGitDiff(
      { cwd: dir, args: { range: "HEAD~1..HEAD" } },
      {
        blobSizes: (cwd, oids) => {
          sizeCalls += 1;
          sizedOids += oids.length;
          return gitBlobSizes(cwd, oids);
        },
        rediffBinaryAsText: (pathspecs) => {
          rediffCalls += 1;
          const path = pathspecs[pathspecs.length - 1]!.replace(":(top,literal)", "");
          return Promise.resolve(`diff --git a/${path} b/${path}\n+rescued\n`);
        },
      },
    );
    expect(sizeCalls).toBe(1);
    expect(sizedOids).toBeLessThanOrEqual(256);
    expect(rediffCalls).toBe(64);
    expect(
      out.warnings.some((w) => w.includes("236 binary file(s) kept as markers (re-diff cap 64)")),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sparseNulText(tag: string): Buffer {
  return Buffer.concat([
    Buffer.from(`start ${tag}\nmid `),
    Buffer.from([0x00]),
    Buffer.from(`dle\nend ${tag}\n`),
  ]);
}

function sparseNulTextV2(tag: string): Buffer {
  return Buffer.concat([
    Buffer.from(`start ${tag}\nmid `),
    Buffer.from([0x00]),
    Buffer.from(`dle\nend ${tag} changed\n`),
  ]);
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function commitGitlink(dir: string, path: string, message: string): void {
  const sha = execSync(`printf '%s' "${message}" | git commit-tree ${EMPTY_TREE}`, {
    cwd: dir,
    shell: "/bin/bash",
  })
    .toString()
    .trim();
  execSync(`git update-index --add --cacheinfo 160000,${sha},${path}`, { cwd: dir });
}

// The raw listing pairs with patch sections by index, but the counts can
// agree while the alignment does not: a file-to-symlink typechange emits one
// raw entry for two `diff --git` sections, and a `diff.submodule=log` gitlink
// bump emits one raw entry and no `diff --git` section at all.
function initRepoWithShiftedSections(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config diff.submodule log", { cwd: dir });
  writeFileSync(join(dir, "a-link"), "x\n");
  writeFileSync(join(dir, "b.bin"), sparseNulText("b"));
  writeFileSync(join(dir, "c.txt"), "c1\n");
  commitGitlink(dir, "d-sub", "sub one");
  execSync('git add a-link b.bin c.txt && git commit -q -m "v1"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  rmSync(join(dir, "a-link"));
  symlinkSync("target", join(dir, "a-link"));
  writeFileSync(join(dir, "b.bin"), sparseNulTextV2("b"));
  writeFileSync(join(dir, "c.txt"), "c2\n");
  commitGitlink(dir, "d-sub", "sub two");
  execSync('git add a-link b.bin c.txt && git commit -q -m "v2"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  return dir;
}

test("git.diff keeps a binary marker when its section index shifted onto another file", async () => {
  const dir = initRepoWithShiftedSections();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).toContain("diff --git a/b.bin b/b.bin");
    expect((out.text.match(/diff --git a\/c\.txt b\/c\.txt/g) ?? []).length).toBe(1);
    expect((out.text.match(/^\+c2$/gm) ?? []).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// In a worktree diff an unmerged path prints a `diff --cc` block first and
// occupies two raw entries; an unstaged typechange prints two `diff --git`
// sections for one raw entry. Equal totals, shifted indexes: the binary
// marker's slot must keep its own header, not take the `diff --cc` text.
function initConflictedWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  writeFileSync(join(dir, "a-link"), "x\n");
  writeFileSync(join(dir, "bin.bin"), sparseNulText("v1"));
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  execSync("git checkout -q -b side", { cwd: dir });
  writeFileSync(join(dir, "conflict.txt"), "side\n");
  execSync('git commit -aqm "side"', { cwd: dir, shell: "/bin/bash" });
  execSync("git checkout -q main", { cwd: dir });
  writeFileSync(join(dir, "conflict.txt"), "main\n");
  execSync('git commit -aqm "main"', { cwd: dir, shell: "/bin/bash" });
  execSync("git merge side || true", { cwd: dir, shell: "/bin/bash" });
  rmSync(join(dir, "a-link"));
  symlinkSync("target", join(dir, "a-link"));
  writeFileSync(join(dir, "bin.bin"), sparseNulTextV2("v2"));
  return dir;
}

test("git.diff keeps a binary marker when a diff --cc block shifted the index pairing", async () => {
  const dir = initConflictedWorktree();
  try {
    const out = await runGitDiff({ cwd: dir, args: {} });
    expect(out.text).toContain("diff --git a/bin.bin b/bin.bin");
    expect(out.text).toContain("Binary files a/bin.bin and b/bin.bin differ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A gitlink bump under diff.submodule=log prints a `Submodule` block instead
// of a `diff --git` section, so the raw listing is available but longer than
// the patch: the warning must name both counts and say markers were kept,
// not claim the listing was unavailable.
test("git.diff reports the raw-vs-section count mismatch when the listing does not align", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config diff.submodule log", { cwd: dir });
  try {
    writeFileSync(join(dir, "b.bin"), sparseNulText("b"));
    commitGitlink(dir, "d-sub", "sub one");
    execSync('git add b.bin && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
    writeFileSync(join(dir, "b.bin"), sparseNulTextV2("b"));
    commitGitlink(dir, "d-sub", "sub two");
    execSync('git add b.bin && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });

    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("did not align");
    expect(out.warnings[0]).toContain("2");
    expect(out.warnings[0]).toContain("1");
    expect(out.warnings[0]).toContain("markers kept");
    expect(out.warnings[0]).not.toContain("unavailable");
    expect(out.text).toContain("Binary files a/b.bin and b/b.bin differ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initRepoWithOddNames(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  for (const [name, tag] of [
    ["café.log", "cafe"],
    ["x and y.log", "xy"],
    ["d[1].txt", "glob"],
  ] as const) {
    writeFileSync(join(dir, name), sparseNulText(tag));
  }
  writeFileSync(join(dir, "d1.txt"), "plain one\n");
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  for (const [name, tag] of [
    ["café.log", "cafe"],
    ["x and y.log", "xy"],
    ["d[1].txt", "glob"],
  ] as const) {
    writeFileSync(join(dir, name), sparseNulTextV2(tag));
  }
  writeFileSync(join(dir, "d1.txt"), "plain one\nplain two\n");
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("git.diff re-diffs binary markers for quoted, spaced, and glob-shaped names", async () => {
  const dir = initRepoWithOddNames();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    expect(out.text).not.toContain("Binary files");
    expect(out.text).toContain("+end cafe changed");
    expect(out.text).toContain("+end xy changed");
    expect(out.text).toContain("+end glob changed");
    expect((out.text.match(/diff --git a\/d1\.txt/g) ?? []).length).toBe(1);
    expect(out.text).toContain("+plain two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff re-diffs binary markers when cwd is a subdirectory of the repo", async () => {
  const dir = initRepoWithOddNames();
  mkdirSync(join(dir, "sub"));
  try {
    const out = await runGitDiff({ cwd: join(dir, "sub"), args: { range: "HEAD~1..HEAD" } });
    expect(out.text).not.toContain("Binary files");
    expect(out.text).toContain("+end cafe changed");
    expect(out.text).toContain("+end xy changed");
    expect(out.text).toContain("+end glob changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff survives the recall budget when a large binary file is in the range", async () => {
  const dir = initRepoWithBinaryBlob();
  const db = new Database(":memory:");
  try {
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      project: "demo",
      sources: [{ source: "git.diff", args: { range: "HEAD~1..HEAD" } }],
      budgetTokens: 24000,
    });
    const diff = bundle.byKey["git.diff"];
    expect(typeof diff).toBe("string");
    expect(diff as string).toContain("+export const version = 2");
    expect(diff as string).toContain("Binary files /dev/null and b/blob.bin differ");
  } finally {
    db.close();
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

// ── max_tokens section cap ──────────────────────────────────────────────────

function initSectionedDiffRepo(bigFiles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config gc.auto 0", { cwd: dir });
  execSync("git config maintenance.auto false", { cwd: dir });
  for (const name of ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]) {
    writeFileSync(join(dir, name), `${name} one\n`);
  }
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  for (const name of ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]) {
    const body = bigFiles.includes(name)
      ? `${name} one\n${"padding line for a large section\n".repeat(80)}`
      : `${name} one\n${name} two\n`;
    writeFileSync(join(dir, name), body);
  }
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

function initSingleFileDiffRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config gc.auto 0", { cwd: dir });
  execSync("git config maintenance.auto false", { cwd: dir });
  writeFileSync(join(dir, "big.txt"), "one\n");
  execSync('git add big.txt && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  const added = Array.from(
    { length: 200 },
    (_, i) => `added line ${String(i)} padding padding`,
  ).join("\n");
  writeFileSync(join(dir, "big.txt"), `one\n${added}\n`);
  execSync('git add big.txt && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

// splitGitDiffSections drops the separator newline before each `diff --git`
// header but keeps the file's own trailing newline on the LAST section; a
// lookahead split keeps every separator on the previous section. Strip one
// trailing newline from non-final sections to mirror the impl's bodies.
function diffSections(text: string): string[] {
  const parts = text.split(/(?=^diff --git )/m);
  return parts.map((section, index) =>
    index < parts.length - 1 && section.endsWith("\n") ? section.slice(0, -1) : section,
  );
}

test("git.diff max_tokens keeps whole leading sections byte-identical and names the dropped files", async () => {
  const dir = initSectionedDiffRepo(["f2.txt", "f3.txt"]);
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const [s0, s1, s2, s3] = diffSections(full.text) as [string, string, string, string];
    const keepChars = s0.length + 1 + s1.length;
    const maxTokens = Math.ceil((keepChars + 700) / 4);

    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
    });
    expect(out.text).toBe(
      `${s0}\n${s1}\n… [recall budget: diff truncated to 2 of 4 file sections; dropped: f2.txt, f3.txt]`,
    );
    expect(out.text).not.toContain("padding line for a large section");
    expect(out.warnings).toEqual([
      `git.diff: recall budget kept 2 of 4 file sections (${String(out.text.length)} of ${String(full.text.length)} chars); dropped 2: f2.txt, f3.txt`,
      `git.diff: truncation_stats=${JSON.stringify({ kept: 2, total: 4, chars: full.text.length, dropped: ["f2.txt", "f3.txt"], overflow: 0, cut_file: null, whole_drop: false })}`,
    ]);
    expect(s2).toContain("f2.txt");
    expect(s3).toContain("f3.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff max_tokens first-fit skips an oversize middle section instead of blanking later ones", async () => {
  const dir = initSectionedDiffRepo(["f1.txt"]);
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const [s0, , s2, s3] = diffSections(full.text) as [string, string, string, string];
    const keepChars = s0.length + 1 + s2.length + 1 + s3.length;
    const maxTokens = Math.ceil((keepChars + 700) / 4);

    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
    });
    expect(out.text).toBe(
      `${s0}\n${s2}\n${s3}… [recall budget: diff truncated to 3 of 4 file sections; dropped: f1.txt]`,
    );
    expect(out.warnings).toEqual([
      `git.diff: recall budget kept 3 of 4 file sections (${String(out.text.length)} of ${String(full.text.length)} chars); dropped 1: f1.txt`,
      `git.diff: truncation_stats=${JSON.stringify({ kept: 3, total: 4, chars: full.text.length, dropped: ["f1.txt"], overflow: 0, cut_file: null, whole_drop: false })}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A dropped name is display-only in the prose warning — paths containing ", "
// or an over-limit dropped list only survive round-trip through the JSON stats
// line the cap emits alongside it.
function initCommaPathDiffRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config gc.auto 0", { cwd: dir });
  execSync("git config maintenance.auto false", { cwd: dir });
  mkdirSync(join(dir, "dir"), { recursive: true });
  writeFileSync(join(dir, "small.txt"), "small one\n");
  writeFileSync(join(dir, "dir", "a, b.ts"), "comma one\n");
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(join(dir, "small.txt"), "small one\nsmall two\n");
  writeFileSync(
    join(dir, "dir", "a, b.ts"),
    `comma one\n${"padding line for a large section\n".repeat(80)}`,
  );
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

function initManyDroppedFilesRepo(dropped: number): string {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config gc.auto 0", { cwd: dir });
  execSync("git config maintenance.auto false", { cwd: dir });
  writeFileSync(join(dir, "keep.txt"), "keep one\n");
  for (let i = 0; i < dropped; i += 1) {
    writeFileSync(join(dir, `drop-${String(i).padStart(2, "0")}.txt`), "drop one\n");
  }
  execSync('git add . && git commit -q -m "v1"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(join(dir, "keep.txt"), "keep one\nkeep two\n");
  for (let i = 0; i < dropped; i += 1) {
    writeFileSync(
      join(dir, `drop-${String(i).padStart(2, "0")}.txt`),
      `drop one\n${"padding line for a large section\n".repeat(80)}`,
    );
  }
  execSync('git add . && git commit -q -m "v2"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

function parseStatsWarning(warnings: string[]): {
  kept: number;
  total: number;
  chars: number;
  dropped: string[];
  overflow: number;
  cut_file: string | null;
  whole_drop: boolean;
} {
  const line = warnings.find((w) => w.startsWith("git.diff: truncation_stats="));
  expect(line).toBeDefined();
  return JSON.parse((line ?? "").slice("git.diff: truncation_stats=".length)) as ReturnType<
    typeof parseStatsWarning
  >;
}

test("git.diff max_tokens carries dropped names with ', ' intact in the stats warning", async () => {
  const dir = initCommaPathDiffRepo();
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const sections = diffSections(full.text);
    // Alphabetical order puts "dir/a, b.ts" first and small.txt last; size the
    // cap so first-fit keeps only the small section.
    const maxTokens = Math.ceil(((sections.at(-1)?.length ?? 0) + 700) / 4);

    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
    });
    const stats = parseStatsWarning(out.warnings);
    expect(stats.dropped).toEqual(["dir/a, b.ts"]);
    expect(stats.overflow).toBe(0);
    expect(stats.kept).toBe(1);
    expect(stats.total).toBe(2);
    // The prose line is human display only; the JSON array is the contract.
    expect(out.warnings.length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff max_tokens caps the stats dropped list at 20 and counts the overflow", async () => {
  const dir = initManyDroppedFilesRepo(24);
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const sections = diffSections(full.text);
    // keep.txt sorts after every drop-*.txt, so the last section is the only
    // one first-fit can afford.
    const maxTokens = Math.ceil(((sections.at(-1)?.length ?? 0) + 700) / 4);

    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
    });
    const stats = parseStatsWarning(out.warnings);
    expect(stats.dropped.length).toBe(20);
    expect(stats.overflow).toBe(4);
    expect(stats.total).toBe(25);
    // No "(+4 more)" suffix glued onto the last name.
    expect(stats.dropped[19]).toBe("drop-19.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff max_tokens cuts a single huge section at a line boundary through a hunk", async () => {
  const dir = initSingleFileDiffRepo();
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const [section] = diffSections(full.text) as [string];
    const maxTokens = Math.ceil((section.length / 2 + 400) / 4);

    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
    });
    const marker = /^… \[recall budget: big\.txt cut to (\d+) of (\d+) chars\]$/m.exec(out.text);
    expect(marker).not.toBeNull();
    const head = out.text.slice(0, out.text.indexOf("\n… [recall budget:"));
    expect(Number(marker?.[1])).toBe(head.length);
    expect(Number(marker?.[2])).toBe(section.length);
    expect(head).toContain("@@");
    expect(/^\+added line \d+ padding padding$/m.test(head)).toBe(true);
    expect(head).not.toContain("added line 199");
    expect(section.startsWith(`${head}\n`)).toBe(true);
    expect(out.warnings).toEqual([
      `git.diff: recall budget kept 0 of 1 file sections (${String(out.text.length)} of ${String(full.text.length)} chars)`,
      `git.diff: truncation_stats=${JSON.stringify({ kept: 0, total: 1, chars: full.text.length, dropped: [], overflow: 0, cut_file: "big.txt", whole_drop: false })}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff max_tokens returns an empty diff when the head cannot reach through one hunk line", async () => {
  const dir = initSingleFileDiffRepo();
  try {
    const full = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const out = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: 20 },
    });
    expect(out.text).toBe("");
    expect(out.warnings).toEqual([
      `git.diff: recall budget dropped the whole diff (1 file sections, ${String(full.text.length)} chars)`,
      `git.diff: truncation_stats=${JSON.stringify({ kept: 0, total: 1, chars: full.text.length, dropped: ["big.txt"], overflow: 0, cut_file: null, whole_drop: true })}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff without max_tokens is byte-identical to today and a huge cap is a no-op", async () => {
  const dir = initSectionedDiffRepo(["f1.txt", "f2.txt"]);
  try {
    const uncapped = await runGitDiff({ cwd: dir, args: { range: "HEAD~1..HEAD" } });
    const capped = await runGitDiff({
      cwd: dir,
      args: { range: "HEAD~1..HEAD", max_tokens: 10_000_000 },
    });
    expect(capped.text).toBe(uncapped.text);
    expect(capped.warnings).toEqual(uncapped.warnings);
    expect(capped.text).not.toContain("[recall budget:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.diff rejects a non-positive or non-integer max_tokens", async () => {
  const dir = initSectionedDiffRepo([]);
  try {
    for (const maxTokens of [0, -5, 2.5]) {
      const out = await runGitDiff({
        cwd: dir,
        args: { range: "HEAD~1..HEAD", max_tokens: maxTokens },
      });
      expect(out.text).toBe("");
      expect(out.warnings).toEqual(["git.diff: invalid max_tokens"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
