import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDefaultDependencyProvider,
  type DependencyProvider,
  type EnsureResult,
  linkDeps,
  readBaseDepsInput,
} from "./deps.js";
import {
  createCandidateTreeGitRun,
  defaultRunCommand,
  materialize,
  type RunCommand,
  type RunCommandResult,
} from "./materialize.js";

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

const tempDirs: string[] = [];

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

// Never rejects: a spawn 'error' event (ENOENT) resolves with code -1. Stdin
// is always ended so children waiting on EOF cannot hang the test.
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: Uint8Array },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {
      // A failed spawn destroys stdin (EPIPE/ERR_STREAM_DESTROYED); the
      // child's own 'error' event already resolves the result.
    });
    child.on("error", (err) => {
      resolve({
        code: -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.from(String(err)),
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

async function git(
  cwd: string,
  args: string[],
  opts: { input?: Uint8Array; env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  const res = await run("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...opts.env },
    input: opts.input,
  });
  if (res.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with code ${String(res.code)}: ${res.stderr.toString("utf8")}`,
    );
  }
  return res.stdout;
}

interface FixtureFile {
  bytes: string | Uint8Array;
  mode?: "100644" | "100755" | "120000";
}

// Blobs go through `git hash-object -w --stdin` with no --path, so attributes
// and filters never rewrite the fixture bytes. `--cacheinfo` stages entries
// (including symlinks and case-colliding names) without touching the worktree.
async function addTreeEntries(dir: string, files: Record<string, FixtureFile>): Promise<void> {
  for (const [path, file] of Object.entries(files)) {
    const bytes = typeof file.bytes === "string" ? Buffer.from(file.bytes, "utf8") : file.bytes;
    const oid = (await git(dir, ["hash-object", "-w", "--stdin"], { input: bytes }))
      .toString("utf8")
      .trim();
    await git(dir, [
      "update-index",
      "--add",
      "--cacheinfo",
      `${file.mode ?? "100644"},${oid},${path}`,
    ]);
  }
}

async function makeRepo(opts: {
  commits: Record<string, FixtureFile>[];
}): Promise<{ dir: string; shas: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-materialize-repo-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-b", "main"]);
  const shas: string[] = [];
  for (const files of opts.commits) {
    await addTreeEntries(dir, files);
    const tree = (await git(dir, ["write-tree"])).toString("utf8").trim();
    const parent = shas.at(-1);
    const parentArgs: string[] = parent === undefined ? [] : ["-p", parent];
    const sha = (
      await git(dir, ["commit-tree", tree, ...parentArgs, "-m", `c${String(shas.length + 1)}`], {
        env: GIT_IDENTITY,
      })
    )
      .toString("utf8")
      .trim();
    await git(dir, ["update-ref", "refs/heads/main", sha]);
    shas.push(sha);
  }
  return { dir, shas };
}

// `git mktree` does not sanitize entry names the way update-index does, so a
// candidate-controlled commit can carry '..' / '.' / '.git' subtrees that
// `ls-tree -r --full-tree` flattens into escaping paths.
interface MktreeEntry {
  name: string;
  inner: { name: string; bytes: string }[];
}

async function makeMktreeCommit(root: string, entries: MktreeEntry[]): Promise<string> {
  const repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  const lines: string[] = [];
  for (const outer of entries) {
    let innerLines = "";
    for (const inner of outer.inner) {
      const oid = (
        await git(repo, ["hash-object", "-w", "--stdin"], {
          input: Buffer.from(inner.bytes, "utf8"),
        })
      )
        .toString("utf8")
        .trim();
      innerLines += `100644 blob ${oid}\t${inner.name}\n`;
    }
    const innerTree = (await git(repo, ["mktree"], { input: Buffer.from(innerLines, "utf8") }))
      .toString("utf8")
      .trim();
    lines.push(`40000 tree ${innerTree}\t${outer.name}`);
  }
  const tree = (
    await git(repo, ["mktree"], { input: Buffer.from(`${lines.join("\n")}\n`, "utf8") })
  )
    .toString("utf8")
    .trim();
  return (await git(repo, ["commit-tree", tree, "-m", "evil"], { env: GIT_IDENTITY }))
    .toString("utf8")
    .trim();
}

// Generalized mktree builder: root-level blobs AND arbitrarily nested
// subtrees, for layouts makeMktreeCommit's flat {name, inner} shape cannot
// express (e.g. a bare-repo root with HEAD, config, objects/ and refs/).
interface MktreeSpec {
  files?: Record<string, string>;
  dirs?: Record<string, MktreeSpec>;
}

async function writeMktreeTree(repo: string, spec: MktreeSpec): Promise<string> {
  const lines: string[] = [];
  for (const [name, bytes] of Object.entries(spec.files ?? {})) {
    const oid = (
      await git(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from(bytes, "utf8") })
    )
      .toString("utf8")
      .trim();
    lines.push(`100644 blob ${oid}\t${name}`);
  }
  for (const [name, inner] of Object.entries(spec.dirs ?? {})) {
    const oid = await writeMktreeTree(repo, inner);
    lines.push(`40000 tree ${oid}\t${name}`);
  }
  const input = Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8");
  return (await git(repo, ["mktree"], { input })).toString("utf8").trim();
}

async function commitMktreeSpec(root: string, spec: MktreeSpec): Promise<string> {
  const repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  const tree = await writeMktreeTree(repo, spec);
  return (await git(repo, ["commit-tree", tree, "-m", "spec"], { env: GIT_IDENTITY }))
    .toString("utf8")
    .trim();
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

// The deps cache is chmodded a-w by the provider; restore u+w before rm -rf.
function chmodTree(dir: string): void {
  chmodSync(dir, statSync(dir).mode | 0o200);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      continue;
    }
    if (ent.isDirectory()) {
      chmodTree(p);
    } else {
      chmodSync(p, statSync(p).mode | 0o200);
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageRoot(name: string, resolvedUrl: string): string {
  let dir = dirname(fileURLToPath(resolvedUrl));
  for (;;) {
    const marker = readMaybe(join(dir, "package.json"));
    if (
      marker !== null &&
      (JSON.parse(marker.toString("utf8")) as { name?: string }).name === name
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json with name ${name} found above ${resolvedUrl}`);
    }
    dir = parent;
  }
}

interface RecordedCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function recordingRunCommand(calls: RecordedCall[]): RunCommand {
  return (cmd, args, opts): Promise<RunCommandResult> => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
}

function mkOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-materialize-out-"));
  tempDirs.push(dir);
  return dir;
}

test("materialize writes blob bytes without applying eol=crlf attributes", async () => {
  const lfBytes = Buffer.from("line1\nline2\n", "utf8");
  const { dir, shas } = await makeRepo({
    commits: [
      {
        ".gitattributes": { bytes: "*.txt eol=crlf\n" },
        "a.txt": { bytes: lfBytes },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.treeDir).toBe(outDir);
  expect(typeof result.gitInTree).toBe("function");
  expect(readMaybe(join(outDir, "a.txt"))).toEqual(lfBytes);
}, 30_000);

test("materialize keeps the $Id$ literal under the ident attribute", async () => {
  const identBytes = Buffer.from("id=$Id$\n", "utf8");
  const { dir, shas } = await makeRepo({
    commits: [
      {
        ".gitattributes": { bytes: "*.txt ident\n" },
        "a.txt": { bytes: identBytes },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "a.txt"))).toEqual(identBytes);
}, 30_000);

test("materialize ignores working-tree-encoding and writes raw blob bytes", async () => {
  const utf8Bytes = Buffer.from("héllo\n", "utf8");
  const { dir, shas } = await makeRepo({
    commits: [
      {
        ".gitattributes": { bytes: "*.txt working-tree-encoding=UTF-16\n" },
        "u.txt": { bytes: utf8Bytes },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "u.txt"))).toEqual(utf8Bytes);
}, 30_000);

test("materialize rejects a symlink tree entry as contract_violation", async () => {
  const { dir, shas } = await makeRepo({
    commits: [
      {
        "target.txt": { bytes: "x\n" },
        "link.txt": { bytes: "target.txt", mode: "120000" },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.mode).toBe("120000");
  expect("unknown" in result).toBe(false);
}, 30_000);

test("materialize rejects case-colliding paths as contract_violation", async () => {
  const { dir, shas } = await makeRepo({
    commits: [
      {
        "A.ts": { bytes: "export const a = 1;\n" },
        "a.ts": { bytes: "export const a = 2;\n" },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.case_collision).toEqual(
    expect.arrayContaining(["A.ts", "a.ts"]),
  );
}, 30_000);

test("materialize rejects a '..' subtree as contract_violation and writes nothing outside outDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-trav-"));
  tempDirs.push(root);
  const sha = await makeMktreeCommit(root, [
    { name: "..", inner: [{ name: "escaped.txt", bytes: "escaped\n" }] },
  ]);
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.path).toBe("../escaped.txt");
  expect(result.model_failure?.detail.unsafe_path).toBe(true);
  expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  expect(existsSync(outDir)).toBe(false);
}, 30_000);

test("materialize rejects a .git directory entry as contract_violation", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-gitdir-"));
  tempDirs.push(root);
  const sha = await makeMktreeCommit(root, [
    { name: ".git", inner: [{ name: "settings", bytes: "injected\n" }] },
  ]);
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.path).toBe(".git/settings");
  expect(result.model_failure?.detail.unsafe_path).toBe(true);
  expect(existsSync(join(outDir, ".git"))).toBe(false);
  expect(existsSync(outDir)).toBe(false);
}, 30_000);

test("materialize rejects a '.' directory entry as contract_violation", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-dot-"));
  tempDirs.push(root);
  const sha = await makeMktreeCommit(root, [{ name: ".", inner: [{ name: "cfg", bytes: "x\n" }] }]);
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.path).toBe("./cfg");
  expect(result.model_failure?.detail.unsafe_path).toBe(true);
  expect(existsSync(outDir)).toBe(false);
}, 30_000);

// git recognizes these as .git (case-folded, HFS+ ignorable-Unicode, NTFS
// short-name, trailing-dot/space); on case-insensitive filesystems they land
// as a real .git, so materialize must reject them without creating outDir.
async function expectGitAliasRejected(alias: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-alias-"));
  tempDirs.push(root);
  const sha = await makeMktreeCommit(root, [
    { name: alias, inner: [{ name: "settings", bytes: "injected\n" }] },
  ]);
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.path).toBe(`${alias}/settings`);
  expect(result.model_failure?.detail.unsafe_path).toBe(true);
  expect(existsSync(outDir)).toBe(false);
}

test("materialize rejects a '.GIT' subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected(".GIT");
}, 30_000);

test("materialize rejects a '.Git' subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected(".Git");
}, 30_000);

test("materialize rejects a .git+U+200C subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected(".git\u200C");
}, 30_000);

test("materialize rejects a 'git~1' subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected("git~1");
}, 30_000);

test("materialize rejects a '.git.' subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected(".git.");
}, 30_000);

test("materialize rejects a '.git ' subtree as contract_violation and leaves no file", async () => {
  await expectGitAliasRejected(".git ");
}, 30_000);

test("materialize rejects a bare-repo root layout as contract_violation and writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-bare-"));
  tempDirs.push(root);
  const sha = await commitMktreeSpec(root, {
    files: {
      HEAD: "ref: refs/heads/main\n",
      config: "[core]\n\tfsmonitor = true\n",
    },
    dirs: {
      objects: { files: { keep: "" } },
      refs: { dirs: { heads: { files: { keep: "" } } } },
    },
  });
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.model_failure?.reason).toBe("contract_violation");
  expect(result.model_failure?.detail.bare_repo_layout).toBe(true);
  expect(existsSync(outDir)).toBe(false);
}, 30_000);

test("materialize accepts a repo-like tree that lacks the full bare-marker set", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-nearmiss-"));
  tempDirs.push(root);
  const sha = await commitMktreeSpec(root, {
    files: { HEAD: "ref: refs/heads/main\n" },
    dirs: {
      objects: { files: { keep: "" } },
      src: { files: { "a.ts": "export const a = 1;\n" } },
    },
  });
  const outDir = join(root, "tree");

  const result = await materialize({ repo: join(root, "repo"), sha, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "src", "a.ts"))).toEqual(
    Buffer.from("export const a = 1;\n", "utf8"),
  );
}, 30_000);

test("createCandidateTreeGitRun guards git invocations and passes other commands through", async () => {
  const parent = mkOutDir();
  const treeDir = join(parent, "tree");
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const base: RunCommand = (cmd, args, opts): Promise<RunCommandResult> => {
    calls.push({ cmd, args, env: opts?.env });
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };

  const gitInTree = createCandidateTreeGitRun(treeDir, base);
  await gitInTree("git", ["status"], { cwd: treeDir, env: { KEEP_ME: "1" } });
  await gitInTree("bun", ["test"], { cwd: treeDir });

  expect(calls).toHaveLength(2);
  expect(calls[0]?.cmd).toBe("git");
  expect(calls[0]?.args).toEqual(["-c", "safe.bareRepository=explicit", "status"]);
  expect(calls[0]?.env?.GIT_CEILING_DIRECTORIES).toBe(parent);
  expect(calls[0]?.env?.KEEP_ME).toBe("1");
  expect(calls[1]?.cmd).toBe("bun");
  expect(calls[1]?.args).toEqual(["test"]);
  expect(calls[1]?.env).toBeUndefined();
});

test("hardened git invocation refuses a candidate tree that looks like a bare repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-materialize-hardened-"));
  tempDirs.push(root);
  const treeDir = join(root, "tree");
  mkdirSync(join(treeDir, "objects"), { recursive: true });
  mkdirSync(join(treeDir, "refs"), { recursive: true });
  writeFileSync(join(treeDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(treeDir, "config"), "[core]\n\tfsmonitor = true\n", "utf8");
  writeFileSync(join(treeDir, "objects", "keep"), "", "utf8");
  writeFileSync(join(treeDir, "refs", "keep"), "", "utf8");

  const gitInTree = createCandidateTreeGitRun(treeDir, defaultRunCommand);
  const res = await gitInTree("git", ["status"], { cwd: treeDir, env: FIXTURE_ENV });

  expect(res.code).not.toBe(0);
  expect(res.stderr.toString("utf8")).toContain("safe.bareRepository");
});

test("materialize preserves the executable bit on 100755 entries", async () => {
  const { dir, shas } = await makeRepo({
    commits: [
      {
        "bin/tool": { bytes: "#!/bin/sh\necho ran\n", mode: "100755" },
        "plain.txt": { bytes: "data\n" },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(statSync(join(outDir, "bin/tool")).mode & 0o777).toBe(0o755);
}, 30_000);

test("materialize rejects a short sha as base_missing, not model_failure", async () => {
  const { dir, shas } = await makeRepo({
    commits: [{ "f.txt": { bytes: "v1\n" } }],
  });
  const outDir = mkOutDir();

  const result = await materialize({
    repo: dir,
    sha: shas[0]!.slice(0, 7),
    outDir,
    gitEnv: FIXTURE_ENV,
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect("model_failure" in result).toBe(false);
  expect(result.unknown?.reason).toBe("base_missing");
}, 30_000);

test("materialize of an earlier sha yields the earlier file bytes", async () => {
  const { dir, shas } = await makeRepo({
    commits: [{ "f.txt": { bytes: "v1\n" } }, { "f.txt": { bytes: "v2\n" } }],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "f.txt"))).toEqual(Buffer.from("v1\n", "utf8"));
}, 30_000);

test("materialize does not include files that were never committed", async () => {
  const { dir, shas } = await makeRepo({
    commits: [{ "committed.txt": { bytes: "yes\n" } }],
  });
  writeFileSync(join(dir, "untracked.txt"), "not committed\n", "utf8");
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "committed.txt"))).toEqual(Buffer.from("yes\n", "utf8"));
  expect(readMaybe(join(outDir, "untracked.txt"))).toBeNull();
}, 30_000);

test("materialize neutralizes candidate config files and records them in removed", async () => {
  const pkgJson = JSON.stringify({ name: "x", bun: { install: {} }, scripts: {} });
  const tsconfigJson = JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/*"] } } });
  const srcBytes = Buffer.from("export const x = 1;\n", "utf8");
  const { dir, shas } = await makeRepo({
    commits: [
      {
        ".env": { bytes: "TOKEN=secret\n" },
        ".env.local": { bytes: "TOKEN=local\n" },
        ".npmrc": { bytes: "registry=https://registry.invalid/\n" },
        "bunfig.toml": { bytes: "[install]\n" },
        "node_modules/zod/index.js": { bytes: "module.exports = {};\n" },
        "package.json": { bytes: pkgJson },
        "pkg/tsconfig.build.json": { bytes: "{}\n" },
        "src/index.ts": { bytes: srcBytes },
        "sub/.bunfig.toml": { bytes: "[install]\n" },
        "tsconfig.json": { bytes: tsconfigJson },
      },
    ],
  });
  const outDir = mkOutDir();

  const result = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(readMaybe(join(outDir, "src/index.ts"))).toEqual(srcBytes);
  for (const rel of [
    ".env",
    ".env.local",
    ".npmrc",
    "bunfig.toml",
    "node_modules/zod/index.js",
    "pkg/tsconfig.build.json",
    "sub/.bunfig.toml",
    "tsconfig.json",
  ]) {
    expect(readMaybe(join(outDir, rel))).toBeNull();
  }
  const pkgBytes = readMaybe(join(outDir, "package.json"));
  expect(pkgBytes).not.toBeNull();
  if (pkgBytes === null) {
    return;
  }
  const pkg = JSON.parse(pkgBytes.toString("utf8")) as Record<string, unknown>;
  expect(pkg.name).toBe("x");
  expect("bun" in pkg).toBe(false);
  expect(result.removed).toEqual([
    ".env",
    ".env.local",
    ".npmrc",
    "bunfig.toml",
    "node_modules/zod/index.js",
    "package.json#bun",
    "pkg/tsconfig.build.json",
    "sub/.bunfig.toml",
    "tsconfig.json",
  ]);
}, 30_000);

test("linkDeps links a cached node_modules so a materialized probe resolves zod", async () => {
  const zodRoot = packageRoot("zod", import.meta.resolve("zod"));
  const { dir, shas } = await makeRepo({
    commits: [
      {
        "probe.ts": {
          bytes: 'import { z } from "zod";\nconsole.log(z.string().parse("ok"));\n',
        },
      },
    ],
  });
  const outDir = mkOutDir();
  const cacheDir = mkOutDir();

  const mres = await materialize({ repo: dir, sha: shas[0]!, outDir, gitEnv: FIXTURE_ENV });
  expect(mres.ok).toBe(true);
  if (!mres.ok) {
    return;
  }

  const provider: DependencyProvider = {
    ensure: (): Promise<EnsureResult> => {
      const nm = join(cacheDir, "node_modules");
      mkdirSync(nm, { recursive: true });
      symlinkSync(zodRoot, join(nm, "zod"), "dir");
      return Promise.resolve({ ok: true, cacheDir });
    },
  };
  const eres = await provider.ensure({
    lockSha256: "",
    lockfileBytes: new Uint8Array(),
    manifests: [],
  });
  expect(eres.ok).toBe(true);
  if (!eres.ok) {
    return;
  }

  await linkDeps({ treeDir: outDir, cacheDir, workspaces: [] });

  const res = await run(process.execPath, ["--no-install", "probe.ts"], { cwd: outDir });
  expect(res.code).toBe(0);
  expect(res.stdout.toString("utf8")).toBe("ok\n");
}, 30_000);

test("default provider runs bun install --frozen-lockfile --ignore-scripts in the cache dir", async () => {
  const cacheRoot = mkOutDir();
  const calls: RecordedCall[] = [];
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: recordingRunCommand(calls),
  });
  const lockfileBytes = Buffer.from("lockfile-bytes-v1\n", "utf8");
  const lockSha256 = sha256Hex(lockfileBytes);

  const res = await provider.ensure({
    lockSha256,
    lockfileBytes,
    manifests: [{ path: "package.json", bytes: Buffer.from('{"name":"x"}\n', "utf8") }],
  });

  expect(res).toEqual({ ok: true, cacheDir: join(cacheRoot, lockSha256) });
  expect(calls).toEqual([
    {
      cmd: "bun",
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
      cwd: join(cacheRoot, lockSha256),
    },
  ]);
});

test("default provider rejects a mismatched lockSha256 without running install", async () => {
  const cacheRoot = mkOutDir();
  const calls: RecordedCall[] = [];
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: recordingRunCommand(calls),
  });

  const res = await provider.ensure({
    lockSha256: "0".repeat(64),
    lockfileBytes: Buffer.from("lockfile-bytes-v1\n", "utf8"),
    manifests: [],
  });

  expect(res).toEqual({ ok: false, reason: "deps_lock_mismatch" });
  expect(calls).toHaveLength(0);
});

test("default provider with allowInstall false returns deps_cache_missing", async () => {
  const cacheRoot = mkOutDir();
  const calls: RecordedCall[] = [];
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: false,
    runCommand: recordingRunCommand(calls),
  });
  const lockfileBytes = Buffer.from("lockfile-bytes-v1\n", "utf8");

  const res = await provider.ensure({
    lockSha256: sha256Hex(lockfileBytes),
    lockfileBytes,
    manifests: [],
  });

  expect(res).toEqual({ ok: false, reason: "deps_cache_missing" });
  expect(calls).toHaveLength(0);
});

test("deps input and cache dir come from the base sha, never the candidate", async () => {
  const basePkg = JSON.stringify({ name: "root", workspaces: ["packages/*"] });
  const baseLock = Buffer.from("base-lock-bytes\n", "utf8");
  const baseA = JSON.stringify({ name: "@x/a" });
  const { dir, shas } = await makeRepo({
    commits: [
      {
        "bun.lock": { bytes: baseLock },
        "package.json": { bytes: basePkg },
        "packages/a/package.json": { bytes: baseA },
      },
      {
        "bun.lock": { bytes: "candidate-lock-bytes\n" },
        "package.json": { bytes: JSON.stringify({ name: "root-candidate" }) },
        "packages/a/package.json": { bytes: JSON.stringify({ name: "@x/a-candidate" }) },
      },
    ],
  });
  const cacheRoot = mkOutDir();
  const baseDigest = sha256Hex(baseLock);

  const input = await readBaseDepsInput({ repo: dir, baseSha: shas[0]!, gitEnv: FIXTURE_ENV });

  expect(input.lockSha256).toBe(baseDigest);
  const rootBytes = input.manifests.find((m) => m.path === "package.json")?.bytes;
  expect(rootBytes === undefined ? null : Buffer.from(rootBytes)).toEqual(
    Buffer.from(basePkg, "utf8"),
  );
  const wsBytes = input.manifests.find((m) => m.path === "packages/a/package.json")?.bytes;
  expect(wsBytes === undefined ? null : Buffer.from(wsBytes)).toEqual(Buffer.from(baseA, "utf8"));

  const calls: RecordedCall[] = [];
  const provider = createDefaultDependencyProvider({
    cacheRoot,
    allowInstall: true,
    runCommand: recordingRunCommand(calls),
  });
  const res = await provider.ensure(input);

  expect(res).toEqual({ ok: true, cacheDir: join(cacheRoot, baseDigest) });
  if (!res.ok) {
    return;
  }
  expect(readMaybe(join(res.cacheDir, "bun.lock"))).toEqual(baseLock);
  expect(readMaybe(join(res.cacheDir, "package.json"))).toEqual(Buffer.from(basePkg, "utf8"));
}, 30_000);
