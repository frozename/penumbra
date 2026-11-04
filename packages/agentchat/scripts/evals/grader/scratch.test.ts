import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { graderBuildId } from "./build-id.js";
import { defaultRunCommand, materialize, type RunCommand } from "./materialize.js";
import { openGraderScratch } from "./scratch.js";

// No global/system config (gpgsign, eol/ident redefinitions) and no inherited
// GIT_* variables (GIT_DIR from a hook, identity overrides) reach the fixture.
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const CANARY_PATCH =
  "diff --git a/a.txt b/a.txt\n" +
  "--- a/a.txt\n" +
  "+++ b/a.txt\n" +
  "@@ -1 +1,2 @@\n" +
  " hello\n" +
  "+CANARY-PATCH\n";

const FULL_SHA = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[0-9a-f]{64}$/;

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Throws on non-zero so fixture setup failures abort the test; assertions on
// command output use the result object directly instead.
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
  const res = await defaultRunCommand("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...env },
  });
  if (res.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with code ${String(res.code)}: ${res.stderr.toString("utf8")}`,
    );
  }
  return res.stdout;
}

// The test's own source repo R: a real git repo in a temp dir (never the
// penumbra checkout) holding one commit with r.txt.
async function makeSourceRepo(): Promise<string> {
  const dir = mkTmp("penumbra-scratch-src-");
  await git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "r.txt"), "r\n", "utf8");
  await git(dir, ["add", "r.txt"]);
  await git(dir, ["commit", "-q", "-m", "r"], GIT_IDENTITY);
  return dir;
}

function readMaybe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        out.push(relative(root, p));
      }
    }
  };
  walk(root);
  return out.sort();
}

function findFileContaining(root: string, needle: string): string | null {
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      const hit = findFileContaining(p, needle);
      if (hit !== null) {
        return hit;
      }
    } else if (ent.isFile() && readFileSync(p).includes(needle)) {
      return p;
    }
  }
  return null;
}

// Pure-JS oracle for the deterministic base commit: blob/tree/commit object
// shas for a flat file map with the eval identity and the pinned timestamp.
function gitObjectSha(type: string, body: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${String(body.length)}\0`, "utf8")
    .update(body)
    .digest("hex");
}

function oracleBaseSha(files: Record<string, string>): string {
  const entries = Object.keys(files)
    .sort()
    .map((name) =>
      Buffer.concat([
        Buffer.from(`100644 ${name}\0`, "utf8"),
        Buffer.from(gitObjectSha("blob", Buffer.from(files[name]!, "utf8")), "hex"),
      ]),
    );
  const tree = gitObjectSha("tree", Buffer.concat(entries));
  const commitText =
    `tree ${tree}\n` +
    "author eval <eval@invalid> 946684800 +0000\n" +
    "committer eval <eval@invalid> 946684800 +0000\n" +
    "\neval base\n";
  return gitObjectSha("commit", Buffer.from(commitText, "utf8"));
}

interface RecordedCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

// Records every invocation, then executes for real — the scratch must only
// ever run git inside temp dirs, so real execution is safe here.
function recordingRunCommand(calls: RecordedCall[]): RunCommand {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return defaultRunCommand(cmd, args, opts);
  };
}

test("scratch base and patch commits stay out of the source repo (r4 M1)", async () => {
  const T = mkTmp("penumbra-scratch-root-");
  const R = await makeSourceRepo();
  const countBefore = (await git(R, ["count-objects", "-v"])).toString("utf8");
  const objectsBefore = listFilesRecursive(join(R, ".git", "objects"));

  const S = await openGraderScratch({ sourceRepo: R, tmpRoot: T });
  tempDirs.push(S.dir);
  try {
    const base = await S.buildBase({ "a.txt": "hello\n" });
    const sha = await S.applyPatch(base, CANARY_PATCH);

    expect(sha).toMatch(FULL_SHA);
    const cat = await S.git(["cat-file", "-p", sha]);
    expect(cat.code).toBe(0);
    expect(cat.stdout.toString("utf8")).toContain(`parent ${base}`);
    const show = await S.git(["show", `${sha}:a.txt`]);
    expect(show.code).toBe(0);
    expect(show.stdout.toString("utf8")).toBe("hello\nCANARY-PATCH\n");

    const all = await git(R, ["cat-file", "--batch-all-objects", "--batch"]);
    expect(all.toString("utf8")).not.toContain("CANARY-PATCH");
    expect((await git(R, ["count-objects", "-v"])).toString("utf8")).toBe(countBefore);
    expect(listFilesRecursive(join(R, ".git", "objects"))).toEqual(objectsBefore);
  } finally {
    if (existsSync(S.dir)) {
      S.close();
    }
  }
}, 30_000);

test("scratch dir is private, borrows objects via alternates, and close() restores everything", async () => {
  const T = mkTmp("penumbra-scratch-root-");
  const R = await makeSourceRepo();
  const listenersBefore = process.listenerCount("exit");

  const S = await openGraderScratch({ sourceRepo: R, tmpRoot: T });
  tempDirs.push(S.dir);
  expect(statSync(S.dir).mode & 0o777).toBe(0o700);
  expect(existsSync(join(S.repoDir, ".git"))).toBe(true);
  expect(
    readMaybe(join(S.repoDir, ".git", "objects", "info", "alternates"))
      ?.toString("utf8")
      .trim(),
  ).toBe(realpathSync(join(R, ".git", "objects")));
  expect(process.listenerCount("exit")).toBe(listenersBefore + 1);

  const base = await S.buildBase({ "a.txt": "hello\n" });
  await S.applyPatch(base, CANARY_PATCH);

  S.close();

  expect(existsSync(S.dir)).toBe(false);
  expect(readdirSync(T)).toEqual([]);
  expect(findFileContaining(T, "CANARY-PATCH")).toBeNull();
  expect(process.listenerCount("exit")).toBe(listenersBefore);
}, 30_000);

test("base commits are hermetic across scratches and match the oracle sha (H1)", async () => {
  const files = { "README.md": "eval\n", "b.txt": "two\n" };
  const s1 = await openGraderScratch({ sourceRepo: null });
  tempDirs.push(s1.dir);
  const s2 = await openGraderScratch({ sourceRepo: null });
  tempDirs.push(s2.dir);
  try {
    const sha1 = await s1.buildBase(files);
    const sha2 = await s2.buildBase(files);
    expect(sha2).toBe(sha1);
    expect(sha1).toBe(oracleBaseSha(files));

    const cat = await s1.git(["cat-file", "-p", sha1]);
    expect(cat.code).toBe(0);
    expect(
      cat.stdout
        .toString("utf8")
        .split("\n")
        .some((line) => line.startsWith("parent ")),
    ).toBe(false);

    const revs = await s1.git(["rev-list", sha1]);
    expect(revs.code).toBe(0);
    expect(revs.stdout.toString("utf8")).toBe(`${sha1}\n`);
  } finally {
    for (const s of [s1, s2]) {
      if (existsSync(s.dir)) {
        s.close();
      }
    }
  }
}, 30_000);

test("a commit created only in the source repo is readable through the scratch", async () => {
  const T = mkTmp("penumbra-scratch-root-");
  const R = await makeSourceRepo();
  writeFileSync(join(R, "cand.txt"), "candidate\n", "utf8");
  await git(R, ["add", "cand.txt"]);
  await git(R, ["commit", "-q", "-m", "c"], GIT_IDENTITY);
  const C = (await git(R, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const countBefore = (await git(R, ["count-objects", "-v"])).toString("utf8");
  const objectsBefore = listFilesRecursive(join(R, ".git", "objects"));

  const S = await openGraderScratch({ sourceRepo: R, tmpRoot: T });
  tempDirs.push(S.dir);
  try {
    const tree = await S.git(["ls-tree", C]);
    expect(tree.code).toBe(0);
    expect(tree.stdout.toString("utf8")).toContain("cand.txt");

    const outDir = S.newTree("c1");
    const result = await materialize({ repo: S.repoDir, sha: C, outDir, gitEnv: S.gitEnv });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(readMaybe(join(outDir, "cand.txt"))).toEqual(Buffer.from("candidate\n", "utf8"));
    expect((await git(R, ["count-objects", "-v"])).toString("utf8")).toBe(countBefore);
    expect(listFilesRecursive(join(R, ".git", "objects"))).toEqual(objectsBefore);
  } finally {
    if (existsSync(S.dir)) {
      S.close();
    }
  }
}, 30_000);

test("a thrown error followed by close() in finally still removes the scratch dir", async () => {
  const T = mkTmp("penumbra-scratch-root-");
  const S = await openGraderScratch({ sourceRepo: null, tmpRoot: T });
  tempDirs.push(S.dir);
  let threw = false;
  try {
    try {
      throw new Error("x");
    } finally {
      S.close();
    }
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(existsSync(S.dir)).toBe(false);
}, 30_000);

test("all scratch git calls share the -C/-c prefix and the scrubbed env", async () => {
  const T = mkTmp("penumbra-scratch-root-");
  const R = await makeSourceRepo();
  const calls: RecordedCall[] = [];

  const S = await openGraderScratch({
    sourceRepo: R,
    tmpRoot: T,
    runCommand: recordingRunCommand(calls),
  });
  tempDirs.push(S.dir);
  try {
    const base = await S.buildBase({ "a.txt": "hello\n" });
    await S.applyPatch(base, CANARY_PATCH);
    S.close();

    const probe = calls.filter((c) => c.args[1] === R);
    expect(probe).toHaveLength(1);
    expect(probe[0]?.cmd).toBe("git");
    expect(probe[0]?.args).toEqual(["-C", R, "rev-parse", "--git-common-dir"]);

    const rest = calls.filter((c) => c.args[1] !== R);
    const gitCalls = rest.filter((c) => c.cmd === "git");
    for (const call of gitCalls) {
      expect(call.args[0]).toBe("-C");
      expect(call.args[1] === S.dir || call.args[1] === S.repoDir).toBe(true);
      expect(call.args.slice(2, 4)).toEqual(["-c", "core.hooksPath=/dev/null"]);
    }
    const initCall = gitCalls.find((c) => c.args[1] === S.dir && c.args.includes("init"));
    expect(initCall?.args.at(-1)).toBe("repo");

    const home = join(S.dir, "home");
    for (const call of rest) {
      expect(call.env?.HOME).toBe(home);
      expect(call.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(call.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(call.env?.GIT_INDEX_FILE).toBe(join(S.dir, "index"));
      expect(call.env?.GIT_AUTHOR_NAME).toBe("eval");
      expect(call.env?.GIT_COMMITTER_NAME).toBe("eval");
      expect(call.env?.GIT_AUTHOR_EMAIL).toBe("eval@invalid");
      expect(call.env?.GIT_COMMITTER_EMAIL).toBe("eval@invalid");
      expect(call.env?.GIT_AUTHOR_DATE).toBe("2000-01-01T00:00:00Z");
      expect(call.env?.GIT_COMMITTER_DATE).toBe("2000-01-01T00:00:00Z");
    }
    expect(calls.length).toBeGreaterThanOrEqual(5);
  } finally {
    if (existsSync(S.dir)) {
      S.close();
    }
  }
}, 30_000);

test("graderBuildId tracks dependency contents and tool versions", async () => {
  const P = mkTmp("penumbra-buildid-proj-");
  const entry = join(P, "entry.ts");
  const dep = join(P, "dep.ts");
  writeFileSync(entry, 'import { d } from "./dep.ts";\nexport const e = d + 1;\n', "utf8");
  writeFileSync(dep, "export const d = 41;\n", "utf8");
  const opts = { entrypoints: [entry], root: P, bunVersion: "b1", gitVersion: "g1" };

  const id1 = await graderBuildId(opts);
  writeFileSync(dep, "export const d = 42;\n", "utf8");
  const id2 = await graderBuildId(opts);
  expect(id2).not.toBe(id1);
  const id3 = await graderBuildId({ ...opts, gitVersion: "g2" });
  expect(id3).not.toBe(id2);
  const id4 = await graderBuildId({ ...opts, bunVersion: "b2" });
  expect(id4).not.toBe(id2);
  for (const id of [id1, id2, id3, id4]) {
    expect(id).toMatch(BUILD_ID);
  }
}, 30_000);

test("graderBuildId does not depend on the process cwd", async () => {
  const P = mkTmp("penumbra-buildid-proj-");
  writeFileSync(
    join(P, "entry.ts"),
    'import { d } from "./dep.ts";\nexport const e = d + 1;\n',
    "utf8",
  );
  writeFileSync(join(P, "dep.ts"), "export const d = 41;\n", "utf8");
  const A = mkTmp("penumbra-buildid-cwd-a-");
  const B = mkTmp("penumbra-buildid-cwd-b-");
  const opts = {
    entrypoints: [join(P, "entry.ts")],
    root: P,
    bunVersion: "b1",
    gitVersion: "g1",
  };
  const original = process.cwd();
  try {
    process.chdir(A);
    const idA = await graderBuildId(opts);
    process.chdir(B);
    const idB = await graderBuildId(opts);
    expect(idB).toBe(idA);
  } finally {
    process.chdir(original);
  }
}, 30_000);

test("graderBuildId with no arguments resolves a stable 64-hex id", async () => {
  const a = await graderBuildId();
  const b = await graderBuildId();
  expect(a).toMatch(BUILD_ID);
  expect(b).toBe(a);
});
