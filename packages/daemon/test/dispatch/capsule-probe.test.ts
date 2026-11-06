import { classifyGitHooks } from "@penumbra/core";
import {
  PreflightResultSchema,
  PROBE_PORT_KEYS,
  resolveRef,
  runPreflight,
} from "@penumbra/core/dispatch/capsule";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CAPSULE_GIT_SUBCOMMANDS,
  type CapsuleExec,
  type CapsuleProbeFs,
  type CapsuleProbeFsStat,
  createCapsuleFsPort,
  createCapsuleGitPort,
  createCapsuleProbePort,
  defaultCapsuleExec,
  defaultCapsuleProbeFs,
  runAllowedGit,
  verifyCapsuleShas,
} from "@src/dispatch/capsule-probe.js";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
] as const;

function git(wt: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", [...GIT_IDENTITY_ARGS, ...args], {
    cwd: wt,
    encoding: "utf8",
    env,
  });
}

type Fixture = {
  root: string;
  wt: string;
  gitEnv: NodeJS.ProcessEnv;
  shaA: string;
  shaB: string;
  headSha: string;
};

function makeFixture(opts: { twoCommits?: boolean; bareTemplate?: boolean } = {}): Fixture {
  const root = makeTmpDir("capsule-probe-");
  const wt = join(root, "repo");
  mkdirSync(wt, { recursive: true });
  const gitHome = join(root, "git-home");
  const gitXdg = join(root, "git-xdg");
  mkdirSync(gitHome);
  mkdirSync(gitXdg);
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: gitHome,
    XDG_CONFIG_HOME: gitXdg,
    LANG: "C",
    LC_ALL: "C",
  };
  git(wt, opts.bareTemplate === true ? ["init", "-q", "--template="] : ["init", "-q"], gitEnv);
  mkdirSync(join(wt, "src"));
  mkdirSync(join(wt, "test"));
  writeFileSync(
    join(wt, "package.json"),
    `${JSON.stringify({
      scripts: {
        prepare: "touch SENTINEL",
        preinstall: "touch SENTINEL",
        test: "touch SENTINEL",
      },
    })}\n`,
  );
  writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(wt, "test", "a.test.ts"), "import { test } from 'bun:test';\n");
  writeFileSync(join(wt, "inside.txt"), "inside\n");
  git(wt, ["add", "."], gitEnv);
  git(wt, ["commit", "-qm", "A"], gitEnv);
  const shaA = git(wt, ["rev-parse", "HEAD"], gitEnv).trim();
  let shaB = shaA;
  if (opts.twoCommits === true) {
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, ["add", "."], gitEnv);
    git(wt, ["commit", "-qm", "B"], gitEnv);
    shaB = git(wt, ["rev-parse", "HEAD"], gitEnv).trim();
  }
  return { root, wt, gitEnv, shaA, shaB, headSha: shaB };
}

function probeDirs(fx: Fixture): { storageRoot: string; operatorCheckout: string } {
  const storageRoot = join(fx.root, "storage");
  const operatorCheckout = join(fx.root, "checkout");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(operatorCheckout, { recursive: true });
  return { storageRoot, operatorCheckout };
}

function installHooksPath(fx: Fixture, configured: string): void {
  git(fx.wt, ["config", "core.hooksPath", configured], fx.gitEnv);
}

function installExecutableHook(fx: Fixture, configured: string): void {
  installHooksPath(fx, configured);
  const hookDir = join(fx.wt, ...configured.split("/").filter((s) => s !== ""));
  mkdirSync(hookDir, { recursive: true });
  const hookFile = join(hookDir, "pre-commit");
  writeFileSync(hookFile, "#!/bin/sh\nexit 0\n");
  chmodSync(hookFile, 0o755);
}

type ExecCall = {
  file: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

function recordingExec(calls: ExecCall[]): CapsuleExec {
  return async (file, argv, opts) => {
    calls.push({ file, argv: [...argv], cwd: opts.cwd, env: { ...opts.env } });
    return await defaultCapsuleExec(file, argv, opts);
  };
}

const READ_ONLY_FS_METHODS = new Set([
  "realpath",
  "stat",
  "lstat",
  "access",
  "readdir",
  "readFile",
  "open",
  "read",
  "close",
]);

const FORBIDDEN_FS_METHODS = [
  "write",
  "mkdir",
  "rm",
  "rename",
  "symlink",
  "chmod",
  "copyFile",
  "appendFile",
  "utimes",
] as const;

function recordingFs(calls: string[]): CapsuleProbeFs {
  return new Proxy(defaultCapsuleProbeFs, {
    get(target, prop): unknown {
      if (typeof prop === "string") {
        calls.push(prop);
      }
      return Reflect.get(target, prop);
    },
  });
}

function snapshotTree(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        rows.push(`${rel}/`);
        walk(abs);
      } else {
        rows.push(`${rel}:${String(lstatSync(abs).size)}`);
      }
    }
  };
  walk(root);
  return rows;
}

function argvHasToken(argv: readonly string[], token: string): boolean {
  return argv.some((arg) => arg === token || arg.startsWith(`${token}=`));
}

const FAKE_FILE_STAT: CapsuleProbeFsStat = {
  size: 0,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
};

test("verifyCapsuleShas reports stale_base when the pinned base is not HEAD", async () => {
  const fx = makeFixture({ twoCommits: true });
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const gitPort = createCapsuleGitPort({ worktreeRoot: fx.wt });

  const stale = await verifyCapsuleShas(gitPort, {
    base_sha: fx.shaA,
    dependency_shas: [],
  });
  expect(stale.ok).toBe(false);
  if (!stale.ok) {
    expect(stale.code).toBe("stale_base");
    expect(typeof stale.detail).toBe("string");
  }

  const fresh = await verifyCapsuleShas(gitPort, {
    base_sha: fx.shaB,
    dependency_shas: [],
  });
  expect(fresh).toEqual({ ok: true });

  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.shaB,
    storageRoot,
    operatorCheckout,
  });
  expect(await port.hasBase()).toEqual({ status: "ok" });
});

test("verifyCapsuleShas reports missing_dependency for shas that do not resolve", async () => {
  const fx = makeFixture({ twoCommits: true });
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const unfetched = "deadbeef".repeat(5);
  const execCalls: ExecCall[] = [];
  const spy = recordingExec(execCalls);
  const gitPort = createCapsuleGitPort({ worktreeRoot: fx.wt, exec: spy });

  expect(await gitPort.resolveSha(unfetched)).toBeNull();
  expect(await gitPort.resolveSha(fx.shaA)).toBe(fx.shaA);

  const result = await verifyCapsuleShas(gitPort, {
    base_sha: fx.shaB,
    dependency_shas: [fx.shaA, unfetched],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("missing_dependency");
    expect(result.detail).toContain(unfetched);
  }

  const portMissing = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: unfetched,
    storageRoot,
    operatorCheckout,
    exec: spy,
  });
  const missingBase = await portMissing.hasBase();
  expect(missingBase.status).toBe("fail");
  if (missingBase.status !== "ok") {
    expect(typeof missingBase.detail).toBe("string");
  }

  for (const call of execCalls) {
    for (const arg of call.argv) {
      expect(arg).not.toContain("origin/main");
      expect(arg).not.toContain("FETCH_HEAD");
      expect(arg).not.toContain("main");
    }
  }
});

test("resolveRef refuses symlink escapes via realpath and artifactReadable denies them", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const outside = makeTmpDir("capsule-outside-");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(outside, "secret.txt"), join(fx.wt, "escape"));

  const deps = {
    fs: createCapsuleFsPort(),
    redactor: {
      redactString: (text: string): { redacted: string } => ({ redacted: text }),
    },
  };
  const scope = { worktree_root: fx.wt, authorized_handles: new Set<string>() };

  const escaped = await resolveRef("escape", scope, deps);
  expect(escaped.ok).toBe(false);
  if (!escaped.ok) {
    expect(escaped.code).toBe("ref_out_of_scope");
  }

  const inside = await resolveRef("inside.txt", scope, deps);
  expect(inside.ok).toBe(true);
  if (inside.ok) {
    expect(new TextDecoder().decode(inside.content)).toBe("inside\n");
  }

  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  const denied = await port.artifactReadable({ id: "a", kind: "file", uri: "escape" });
  expect(denied.status).toBe("denied");
  if (denied.status !== "ok") {
    expect(typeof denied.detail).toBe("string");
  }
  expect(await port.artifactReadable({ id: "a", kind: "file", uri: "inside.txt" })).toEqual({
    status: "ok",
  });

  const alias = join(fx.root, "wt-alias");
  symlinkSync(fx.wt, alias, "dir");
  const viaAlias = await resolveRef(
    "inside.txt",
    { worktree_root: alias, authorized_handles: new Set<string>() },
    deps,
  );
  expect(viaAlias.ok).toBe(true);
  if (viaAlias.ok) {
    expect(new TextDecoder().decode(viaAlias.content)).toBe("inside\n");
  }
});

test("hookStatus reports installed when core.hooksPath points at executable client hooks", async () => {
  const fx = makeFixture();
  installExecutableHook(fx, ".husky/_");
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });

  const expected = classifyGitHooks(fx.wt, ".husky/_").status;
  expect(expected).toBe("installed");
  const outcome = await port.hookStatus();
  expect(outcome).toEqual({ status: "ok", hooks: expected });
  expect(outcome).toEqual({ status: "ok", hooks: "installed" });
});

test("hookStatus reports missing when the configured hooks dir does not exist", async () => {
  const fx = makeFixture();
  installHooksPath(fx, ".husky/_");
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });

  const expected = classifyGitHooks(fx.wt, ".husky/_").status;
  expect(expected).toBe("missing");
  expect(await port.hookStatus()).toEqual({ status: "ok", hooks: expected });
  expect(await port.hookStatus()).toEqual({ status: "ok", hooks: "missing" });
});

test("hookStatus reports not_configured when core.hooksPath is unset", async () => {
  const fxNormal = makeFixture();
  const dirsNormal = probeDirs(fxNormal);
  const portNormal = createCapsuleProbePort({
    worktreeRoot: fxNormal.wt,
    baseSha: fxNormal.headSha,
    storageRoot: dirsNormal.storageRoot,
    operatorCheckout: dirsNormal.operatorCheckout,
  });
  const outcomeNormal = await portNormal.hookStatus();
  expect(outcomeNormal).toEqual({ status: "ok", hooks: "not_configured" });
  expect(outcomeNormal).toEqual({
    status: "ok",
    hooks: classifyGitHooks(fxNormal.wt, null).status,
  });

  const fxEmpty = makeFixture({ bareTemplate: true });
  const defaultHooksDir = join(fxEmpty.wt, ".git", "hooks");
  // Pin the fixture shape only when this git honors --template=; gits that
  // still create .git/hooks skip just this assertion, never the probe check.
  if (!existsSync(defaultHooksDir)) {
    expect(existsSync(defaultHooksDir)).toBe(false);
  }
  const dirsEmpty = probeDirs(fxEmpty);
  const portEmpty = createCapsuleProbePort({
    worktreeRoot: fxEmpty.wt,
    baseSha: fxEmpty.headSha,
    storageRoot: dirsEmpty.storageRoot,
    operatorCheckout: dirsEmpty.operatorCheckout,
  });
  expect(await portEmpty.hookStatus()).toEqual({ status: "ok", hooks: "not_configured" });
});

test("spawns only allowlisted git subcommands with a PATH-only env and no fs writes", async () => {
  const fx = makeFixture({ twoCommits: true });
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const execCalls: ExecCall[] = [];
  const fsCalls: string[] = [];
  const spy = recordingExec(execCalls);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    exec: spy,
    fs: recordingFs(fsCalls),
  });
  const gitPort = createCapsuleGitPort({ worktreeRoot: fx.wt, exec: spy });
  for (const key of PROBE_PORT_KEYS) {
    expect(typeof port[key]).toBe("function");
  }

  const before = snapshotTree(fx.wt);

  await port.hasBase();
  await port.hasCode();
  await port.hasTests();
  await port.runtime("bun");
  await port.pathTool("git");
  await port.storagePath();
  await port.operatorCheckout();
  await port.artifactReadable({ id: "a", kind: "file", uri: "inside.txt" });
  await port.hookStatus();
  await gitPort.head();
  await gitPort.resolveSha(fx.shaB);

  expect(execCalls.length).toBeGreaterThan(0);
  const seenSubcommands = new Set(execCalls.map((call) => call.argv[0]));
  for (const subcommand of CAPSULE_GIT_SUBCOMMANDS) {
    expect(seenSubcommands.has(subcommand)).toBe(true);
  }
  for (const call of execCalls) {
    expect(call.file).toBe("git");
    expect(CAPSULE_GIT_SUBCOMMANDS).toContain(call.argv[0] ?? "");
    for (const token of ["-c", "config", "--exec-path", "-C"]) {
      expect(argvHasToken(call.argv, token)).toBe(false);
    }
    expect(call.cwd).toBe(fx.wt);
    expect(Object.keys(call.env)).toEqual(["PATH"]);
  }

  const env = { PATH: process.env["PATH"] ?? "" };
  const callsBeforeReject = execCalls.length;
  const configAttempt = await runAllowedGit(spy, fx.wt, ["config", "--get", "core.hooksPath"], env);
  expect(configAttempt.ok).toBe(false);
  const dashCAttempt = await runAllowedGit(spy, fx.wt, ["-c", "x=y", "rev-parse", "HEAD"], env);
  expect(dashCAttempt.ok).toBe(false);
  expect(execCalls.length).toBe(callsBeforeReject);

  const head = await runAllowedGit(spy, fx.wt, ["rev-parse", "HEAD"], env);
  expect(head.ok).toBe(true);
  if (head.ok) {
    expect(head.stdout.trim()).toBe(fx.headSha);
  }

  expect(existsSync(join(fx.wt, "SENTINEL"))).toBe(false);
  expect(snapshotTree(fx.wt)).toEqual(before);

  const seenFs = new Set(fsCalls);
  expect(seenFs.size).toBeGreaterThan(0);
  for (const name of seenFs) {
    expect(READ_ONLY_FS_METHODS.has(name)).toBe(true);
  }
  for (const name of FORBIDDEN_FS_METHODS) {
    expect(seenFs.has(name)).toBe(false);
  }
});

test("reads only PATH from the environment and resolves tools per call", async () => {
  const src = readFileSync(join(import.meta.dir, "../../src/dispatch/capsule-probe.ts"), "utf8");
  const envReads = src.match(/process\.env(?:\.\w+|\[[^\]]*\])?/g) ?? [];
  expect(envReads.length).toBeGreaterThan(0);
  expect(
    envReads.every((read) => read === "process.env.PATH" || read === 'process.env["PATH"]'),
  ).toBe(true);
  expect(src).not.toContain("Bun.env");
  expect(src).not.toContain("import.meta.env");
  expect(src).not.toContain("shell: true");
  expect(src).toContain("repo-local hook configuration only");

  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const binDir = join(fx.root, "bin");
  mkdirSync(binDir);
  const toolFile = join(binDir, "capsule-fake-tool");
  writeFileSync(toolFile, "#!/bin/sh\nexit 0\n");
  chmodSync(toolFile, 0o755);

  const portBefore = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });

  const originalPath = process.env["PATH"];
  process.env["PATH"] = binDir + delimiter + (originalPath ?? "");
  try {
    const portAfter = createCapsuleProbePort({
      worktreeRoot: fx.wt,
      baseSha: fx.headSha,
      storageRoot,
      operatorCheckout,
    });
    expect((await portAfter.pathTool("capsule-fake-tool")).status).toBe("ok");
    expect((await portAfter.pathTool("../x")).status).toBe("fail");
    expect((await portBefore.pathTool("capsule-fake-tool")).status).toBe("ok");
  } finally {
    if (originalPath === undefined) {
      Reflect.deleteProperty(process.env, "PATH");
    } else {
      process.env["PATH"] = originalPath;
    }
  }
});

function makeEmptyRepoFixture(): { root: string; wt: string; gitEnv: NodeJS.ProcessEnv } {
  const root = makeTmpDir("capsule-probe-empty-");
  const wt = join(root, "repo");
  mkdirSync(wt, { recursive: true });
  const gitHome = join(root, "git-home");
  const gitXdg = join(root, "git-xdg");
  mkdirSync(gitHome);
  mkdirSync(gitXdg);
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: gitHome,
    XDG_CONFIG_HOME: gitXdg,
    LANG: "C",
    LC_ALL: "C",
  };
  git(wt, ["init", "-q"], gitEnv);
  return { root, wt, gitEnv };
}

test("resolveSha rejects refs, options, abbreviated and uppercase shas before invoking git", async () => {
  const fx = makeFixture();
  const execCalls: ExecCall[] = [];
  const gitPort = createCapsuleGitPort({
    worktreeRoot: fx.wt,
    exec: recordingExec(execCalls),
  });
  const rejected = ["main", "HEAD", "--output=x", fx.shaA.slice(0, 8), fx.shaA.toUpperCase()];
  for (const candidate of rejected) {
    expect(await gitPort.resolveSha(candidate)).toBeNull();
  }
  expect(execCalls.length).toBe(0);
  for (const candidate of rejected) {
    for (const call of execCalls) {
      expect(argvHasToken(call.argv, candidate)).toBe(false);
    }
  }

  expect(await gitPort.resolveSha(fx.shaA)).toBe(fx.shaA);
  expect(execCalls.length).toBe(1);
  expect(execCalls[0]?.argv).toEqual(["cat-file", "-t", fx.shaA]);
});

test("storagePath and operatorCheckout return realpath-canonicalised paths", async () => {
  const fx = makeFixture();
  const realStorage = join(fx.root, "storage");
  const realCheckout = join(fx.root, "checkout");
  mkdirSync(realStorage, { recursive: true });
  mkdirSync(realCheckout, { recursive: true });
  const storageAlias = join(fx.root, "storage-alias");
  const checkoutAlias = join(fx.root, "checkout-alias");
  symlinkSync(realStorage, storageAlias, "dir");
  symlinkSync(realCheckout, checkoutAlias, "dir");

  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot: storageAlias,
    operatorCheckout: checkoutAlias,
  });
  const storage = await port.storagePath();
  expect(storage.status).toBe("ok");
  if (storage.status === "ok") {
    expect(storage.path).toBe(realpathSync(storageAlias));
    expect(storage.path).not.toBe(storageAlias);
  }
  const checkout = await port.operatorCheckout();
  expect(checkout.status).toBe("ok");
  if (checkout.status === "ok") {
    expect(checkout.path).toBe(realpathSync(checkoutAlias));
    expect(checkout.path).not.toBe(checkoutAlias);
  }
});

test("verifyCapsuleShas reports stale_base when HEAD cannot be resolved", async () => {
  const empty = makeEmptyRepoFixture();
  const emptyResult = await verifyCapsuleShas(createCapsuleGitPort({ worktreeRoot: empty.wt }), {
    base_sha: "0".repeat(40),
    dependency_shas: [],
  });
  expect(emptyResult.ok).toBe(false);
  if (!emptyResult.ok) {
    expect(emptyResult.code).toBe("stale_base");
    expect(typeof emptyResult.detail).toBe("string");
  }

  const fx = makeFixture();
  const failingExec: CapsuleExec = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
  const failingPort = createCapsuleGitPort({ worktreeRoot: fx.wt, exec: failingExec });
  expect(await failingPort.head()).toBeNull();
  const failingResult = await verifyCapsuleShas(failingPort, {
    base_sha: fx.shaA,
    dependency_shas: [],
  });
  expect(failingResult.ok).toBe(false);
  if (!failingResult.ok) {
    expect(failingResult.code).toBe("stale_base");
  }
});

test("resolveSha requires cat-file type commit; tree and blob shas give null and missing_dependency", async () => {
  const fx = makeFixture();
  const treeSha = git(fx.wt, ["rev-parse", "HEAD^{tree}"], fx.gitEnv).trim();
  const blobSha = git(fx.wt, ["hash-object", "-w", "inside.txt"], fx.gitEnv).trim();
  expect(treeSha).toMatch(/^[0-9a-f]{40}$/);
  expect(blobSha).toMatch(/^[0-9a-f]{40}$/);

  const gitPort = createCapsuleGitPort({ worktreeRoot: fx.wt });
  expect(await gitPort.resolveSha(treeSha)).toBeNull();
  expect(await gitPort.resolveSha(blobSha)).toBeNull();
  expect(await gitPort.resolveSha(fx.shaA)).toBe(fx.shaA);

  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const baseAsTree = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: treeSha,
    storageRoot,
    operatorCheckout,
  });
  expect((await baseAsTree.hasBase()).status).toBe("fail");

  for (const dependency of [treeSha, blobSha]) {
    const result = await verifyCapsuleShas(gitPort, {
      base_sha: fx.headSha,
      dependency_shas: [dependency],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_dependency");
      expect(result.detail).toContain(dependency);
    }
  }
});

test("hasTests fails without test paths and hasCode fails on an empty tracked listing", async () => {
  const noTests = makeEmptyRepoFixture();
  mkdirSync(join(noTests.wt, "src"), { recursive: true });
  writeFileSync(join(noTests.wt, "src", "a.ts"), "export const a = 1;\n");
  git(noTests.wt, ["add", "."], noTests.gitEnv);
  git(noTests.wt, ["commit", "-qm", "sources only"], noTests.gitEnv);
  const noTestsHead = git(noTests.wt, ["rev-parse", "HEAD"], noTests.gitEnv).trim();
  const noTestsStorage = join(noTests.root, "storage");
  const noTestsCheckout = join(noTests.root, "checkout");
  mkdirSync(noTestsStorage);
  mkdirSync(noTestsCheckout);
  const portNoTests = createCapsuleProbePort({
    worktreeRoot: noTests.wt,
    baseSha: noTestsHead,
    storageRoot: noTestsStorage,
    operatorCheckout: noTestsCheckout,
  });
  expect((await portNoTests.hasCode()).status).toBe("ok");
  expect((await portNoTests.hasTests()).status).toBe("fail");

  const empty = makeEmptyRepoFixture();
  const emptyStorage = join(empty.root, "storage");
  mkdirSync(emptyStorage);
  const portEmpty = createCapsuleProbePort({
    worktreeRoot: empty.wt,
    baseSha: "0".repeat(40),
    storageRoot: emptyStorage,
    operatorCheckout: emptyStorage,
  });
  expect((await portEmpty.hasCode()).status).toBe("fail");
  expect((await portEmpty.hasTests()).status).toBe("fail");
});

test("artifactReadable fails on a directory handle", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  const dirResult = await port.artifactReadable({ id: "d", kind: "file", uri: "src" });
  expect(dirResult.status).toBe("fail");
  if (dirResult.status !== "ok") {
    expect(typeof dirResult.detail).toBe("string");
  }
  expect(await port.artifactReadable({ id: "f", kind: "file", uri: "inside.txt" })).toEqual({
    status: "ok",
  });
});

test("pathTool rejects malformed tool names without stat or access calls", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const fsCalls: string[] = [];
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    fs: recordingFs(fsCalls),
  });
  for (const name of ["../x", "a/b", "a b"]) {
    expect((await port.pathTool(name)).status).toBe("fail");
  }
  expect(fsCalls.filter((call) => call === "stat" || call === "access")).toEqual([]);

  expect((await port.pathTool("git")).status).toBe("ok");
  expect(fsCalls).toContain("stat");
});

test("hookStatus treats a symlink alias of the default hooks dir as the default", async () => {
  const fx = makeFixture();
  const defaultHooks = join(fx.wt, ".git", "hooks");
  expect(existsSync(defaultHooks)).toBe(true);
  symlinkSync(defaultHooks, join(fx.wt, "hooks-alias"), "dir");
  installHooksPath(fx, "hooks-alias");
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });

  expect(await port.hookStatus()).toEqual({ status: "ok", hooks: "not_configured" });
  expect(await port.hookStatus()).toEqual({
    status: "ok",
    hooks: classifyGitHooks(fx.wt, null).status,
  });
});

test("runPreflight over the capsule probe port is ready for an isolated worktree", async () => {
  const fx = makeFixture();
  installExecutableHook(fx, ".husky/_");
  const storageRoot = makeTmpDir("capsule-storage-");
  const operatorCheckout = makeTmpDir("capsule-checkout-");
  const homeDir = makeTmpDir("capsule-home-");

  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  const req = {
    runtimes: [],
    tools: [{ id: "git", kind: "cli", command: "git" }],
    supported_tool_kinds: ["cli"],
    artifact_handles: [{ id: "a", kind: "file", uri: "inside.txt" }],
    home_dir: homeDir,
  };
  const result = await runPreflight(port, req);
  expect(result.ready).toBe(true);
  expect(() => PreflightResultSchema.parse(result)).not.toThrow();

  const nestedStorage = join(operatorCheckout, "nested-storage");
  mkdirSync(nestedStorage);
  const portNested = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot: nestedStorage,
    operatorCheckout,
  });
  const resultNested = await runPreflight(portNested, req);
  expect(resultNested.ready).toBe(false);
  expect(resultNested.failures.some((failure) => failure.code === "storage_not_isolated")).toBe(
    true,
  );
});

test("artifactReadable returns unknown for file URLs that fileURLToPath rejects", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  for (const uri of ["file://evil/x", "file:///a/%2Fb"]) {
    // bun:test types .resolves matchers as void; the await is required at runtime.
    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression
    await expect(port.artifactReadable({ id: "a", kind: "file", uri })).resolves.toEqual({
      status: "unknown",
      detail: "unsupported artifact uri",
    });
  }
  expect(
    await port.artifactReadable({
      id: "a",
      kind: "file",
      uri: pathToFileURL(join(fx.wt, "inside.txt")).href,
    }),
  ).toEqual({ status: "ok" });
});

test("runtime ignores inherited prototype keys", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    runtimeVersions: { bun: "1.2.3" },
  });
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const outcome = await port.runtime(name);
    expect(outcome.status).toBe("fail");
    expect(outcome).toEqual({ status: "fail", detail: `runtime ${name} not available` });
  }
  expect(await port.runtime("bun")).toEqual({ status: "ok", version: "1.2.3" });

  const defaultPort = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  for (const name of ["constructor", "__proto__"]) {
    const outcome = await defaultPort.runtime(name);
    expect(outcome.status).toBe("fail");
    expect(outcome).toEqual({ status: "fail", detail: `runtime ${name} not available` });
  }
});

test("runtime rejects inherited prototype versions (pins own-property guard)", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    runtimeVersions: Object.create({ bun: "9.9.9" }) as Record<string, string>,
  });
  expect(await port.runtime("bun")).toEqual({
    status: "fail",
    detail: "runtime bun not available",
  });
});

test("runtime requires a string version", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    runtimeVersions: { bun: 1 as unknown as string },
  });
  expect(await port.runtime("bun")).toEqual({
    status: "fail",
    detail: "runtime bun not available",
  });
});

test("artifactReadable denies sibling-directory escapes sharing the worktree prefix", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const evilDir = join(fx.root, "repo-evil");
  mkdirSync(evilDir);
  writeFileSync(join(evilDir, "x.txt"), "evil\n");
  symlinkSync(join(evilDir, "x.txt"), join(fx.wt, "sib"));
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  expect(await port.artifactReadable({ id: "s", kind: "file", uri: "sib" })).toEqual({
    status: "denied",
    detail: "artifact escapes worktree",
  });
});

test("runAllowedGit rejects forbidden git options after an allowed subcommand", async () => {
  const fx = makeFixture();
  const env = { PATH: process.env.PATH ?? "" };
  let calls = 0;
  const countingExec: CapsuleExec = () => {
    calls += 1;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  for (const argv of [
    ["rev-parse", "-c", "x"],
    ["rev-parse", "-C", "/tmp", "HEAD"],
    ["ls-files", "--exec-path"],
    ["cat-file", "--exec-path=/tmp"],
  ]) {
    expect(await runAllowedGit(countingExec, fx.wt, argv, env)).toEqual({
      ok: false,
      detail: "git subcommand not allowed",
    });
    expect(calls).toBe(0);
  }
});

test("artifactReadable returns unknown for traversal, parent, absolute and remote uris", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
  });
  for (const uri of [
    "src/../inside.txt",
    "../repo/inside.txt",
    join(fx.wt, "inside.txt"),
    "https://x/y",
  ]) {
    expect(await port.artifactReadable({ id: "a", kind: "file", uri })).toEqual({
      status: "unknown",
      detail: "unsupported artifact uri",
    });
  }
});

test("artifactReadable and pathTool enforce readability, file-type and exec-bit checks", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);

  const accessCalls: { path: string; mode: number | undefined }[] = [];
  const denyingFs: CapsuleProbeFs = {
    ...defaultCapsuleProbeFs,
    access: (path, mode) => {
      accessCalls.push({ path, mode });
      return Promise.reject(new Error("denied"));
    },
  };
  const portDeny = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    fs: denyingFs,
  });
  expect(await portDeny.artifactReadable({ id: "a", kind: "file", uri: "inside.txt" })).toEqual({
    status: "fail",
    detail: "artifact is not readable",
  });
  const realInside = realpathSync(join(fx.wt, "inside.txt"));
  expect(accessCalls.some((call) => call.mode === constants.R_OK && call.path === realInside)).toBe(
    true,
  );

  const dirToolBin = join(fx.root, "dir-bin");
  mkdirSync(join(dirToolBin, "capsule-dir-tool"), { recursive: true });
  chmodSync(join(dirToolBin, "capsule-dir-tool"), 0o755);
  const portDirTool = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    pathEnv: dirToolBin,
  });
  expect((await portDirTool.pathTool("capsule-dir-tool")).status).toBe("fail");

  const execModes: (number | undefined)[] = [];
  const execBitFs: CapsuleProbeFs = {
    ...defaultCapsuleProbeFs,
    stat: () => Promise.resolve(FAKE_FILE_STAT),
    access: (_path, mode) => {
      execModes.push(mode);
      return mode === constants.X_OK
        ? Promise.resolve()
        : Promise.reject(new Error("unexpected access mode"));
    },
  };
  const fakeBin = join(fx.root, "fake-bin");
  const portExecBit = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    fs: execBitFs,
    pathEnv: fakeBin,
  });
  expect(await portExecBit.pathTool("anytool")).toEqual({ status: "ok" });
  expect(execModes.length).toBeGreaterThan(0);
  for (const mode of execModes) {
    expect(mode).toBe(constants.X_OK);
  }

  const denyAccessFs: CapsuleProbeFs = {
    ...defaultCapsuleProbeFs,
    stat: () => Promise.resolve(FAKE_FILE_STAT),
    access: () => Promise.reject(new Error("denied")),
  };
  const portDenyAccess = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    fs: denyAccessFs,
    pathEnv: fakeBin,
  });
  expect((await portDenyAccess.pathTool("anytool")).status).toBe("fail");
});

test("pathTool skips relative PATH entries without touching the filesystem", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const statPaths: string[] = [];
  const permissiveFs: CapsuleProbeFs = {
    ...defaultCapsuleProbeFs,
    stat: (path) => {
      statPaths.push(path);
      return Promise.resolve(FAKE_FILE_STAT);
    },
    access: () => Promise.resolve(),
  };
  const port = createCapsuleProbePort({
    worktreeRoot: fx.wt,
    baseSha: fx.headSha,
    storageRoot,
    operatorCheckout,
    fs: permissiveFs,
    pathEnv: ["relbin", "./x", "", ""].join(delimiter),
  });
  expect(await port.pathTool("git")).toEqual({
    status: "fail",
    detail: "tool git not available",
  });
  expect(statPaths).toEqual([]);
});

test("hookStatus reports unknown when either git path probe fails", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  for (const token of ["--git-path", "--git-common-dir"]) {
    const port = createCapsuleProbePort({
      worktreeRoot: fx.wt,
      baseSha: fx.headSha,
      storageRoot,
      operatorCheckout,
      exec: async (file, argv, opts) =>
        argv.includes(token)
          ? { code: 1, stdout: "", stderr: "" }
          : await defaultCapsuleExec(file, argv, opts),
    });
    expect(await port.hookStatus()).toEqual({
      status: "unknown",
      detail: "hooks path unresolved",
    });
  }
});

test("hasTests matches test path segments but not lookalike names", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const portFor = (files: string[]): ReturnType<typeof createCapsuleProbePort> =>
    createCapsuleProbePort({
      worktreeRoot: fx.wt,
      baseSha: fx.headSha,
      storageRoot,
      operatorCheckout,
      exec: () => Promise.resolve({ code: 0, stdout: files.join("\u0000"), stderr: "" }),
    });
  for (const file of ["tests/data.json", "__tests__/x.js", "pkg/test/fixture.txt", "test/x"]) {
    expect((await portFor([file]).hasTests()).status).toBe("ok");
  }
  for (const file of ["latest/x.ts", "contest/a.js", "src/testing.ts"]) {
    expect(await portFor([file]).hasTests()).toEqual({
      status: "fail",
      detail: "no tracked test files",
    });
  }
});

test("probe outcomes fail for missing runtimes, directories, worktree and artifacts", async () => {
  const fx = makeFixture();
  const { storageRoot, operatorCheckout } = probeDirs(fx);
  const base = { worktreeRoot: fx.wt, baseSha: fx.headSha, storageRoot, operatorCheckout };

  const portRuntime = createCapsuleProbePort({ ...base, runtimeVersions: { bun: "1" } });
  expect(await portRuntime.runtime("python")).toEqual({
    status: "fail",
    detail: "runtime python not available",
  });

  const portMissingDirs = createCapsuleProbePort({
    ...base,
    storageRoot: join(fx.root, "missing-storage"),
    operatorCheckout: join(fx.root, "missing-checkout"),
  });
  expect(await portMissingDirs.storagePath()).toEqual({
    status: "fail",
    detail: "configured directory unavailable",
  });
  expect(await portMissingDirs.operatorCheckout()).toEqual({
    status: "fail",
    detail: "configured directory unavailable",
  });

  const portMissingWt = createCapsuleProbePort({
    ...base,
    worktreeRoot: join(fx.root, "missing-worktree"),
  });
  expect(
    await portMissingWt.artifactReadable({ id: "a", kind: "file", uri: "inside.txt" }),
  ).toEqual({ status: "fail", detail: "worktree root unavailable" });

  const port = createCapsuleProbePort(base);
  expect(await port.artifactReadable({ id: "a", kind: "file", uri: "nope.txt" })).toEqual({
    status: "fail",
    detail: "artifact path unavailable",
  });
});

test("FsPort read bounds output by maxBytes and closes once per read", async () => {
  const fx = makeFixture();
  const file = join(fx.root, "ten.txt");
  writeFileSync(file, "0123456789");

  const fsPort = createCapsuleFsPort();
  const small = await fsPort.read(file, { maxBytes: 4 });
  expect(small.length).toBe(4);
  expect(new TextDecoder().decode(small)).toBe("0123");
  const large = await fsPort.read(file, { maxBytes: 64 });
  expect(large.length).toBe(10);
  expect(new TextDecoder().decode(large)).toBe("0123456789");

  let closeCalls = 0;
  const countingFs: CapsuleProbeFs = {
    ...defaultCapsuleProbeFs,
    open: async (path, flags) => {
      const handle = await defaultCapsuleProbeFs.open(path, flags);
      return {
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async (): Promise<void> => {
          closeCalls += 1;
          await handle.close();
        },
      };
    },
  };
  const countingPort = createCapsuleFsPort(countingFs);
  await countingPort.read(file, { maxBytes: 4 });
  await countingPort.read(file, { maxBytes: 4 });
  expect(closeCalls).toBe(2);
});
