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

import {
  CAPSULE_GIT_SUBCOMMANDS,
  type CapsuleExec,
  type CapsuleProbeFs,
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
