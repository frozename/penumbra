import type {
  ArtifactHandle,
  CapsuleRefusal,
  FsPort,
  FsStat,
  HookProbeOutcome,
  PathProbeOutcome,
  ProbeOutcome,
  ProbePort,
  RuntimeProbeOutcome,
} from "@penumbra/core/dispatch/capsule";

import { classifyGitHooks } from "@penumbra/core";
import { refusal } from "@penumbra/core/dispatch/capsule";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPSULE_GIT_SUBCOMMANDS: readonly string[] = ["rev-parse", "cat-file", "ls-files"];

const FORBIDDEN_GIT_OPTIONS = ["-c", "-C", "--exec-path"] as const;
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const CAPSULE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOOL_NAME_PATTERN = /^[\w.+-]+$/;
const TEST_PATH_PATTERN = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NUL = "\u0000";

export type CapsuleExec = (
  file: string,
  argv: readonly string[],
  opts: { cwd: string; env: Readonly<Record<string, string>> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type GitRunResult = { ok: true; stdout: string } | { ok: false; detail: string };

function capsulePathEnv(override?: string): string {
  return override ?? process.env.PATH ?? "";
}

function execErrorCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "number" && code !== 0) {
      return code;
    }
  }
  return 1;
}

export const defaultCapsuleExec: CapsuleExec = (file, argv, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...argv],
      {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        resolve({
          code: execErrorCode(error),
          stdout: typeof error.stdout === "string" ? error.stdout : "",
          stderr: typeof error.stderr === "string" ? error.stderr : "",
        });
      },
    );
  });

function gitArgvViolation(argv: readonly string[]): string | null {
  if (!CAPSULE_GIT_SUBCOMMANDS.includes(argv[0] ?? "")) {
    return "git subcommand not allowed";
  }
  for (const arg of argv) {
    if (
      (FORBIDDEN_GIT_OPTIONS as readonly string[]).includes(arg) ||
      arg.startsWith("--exec-path=")
    ) {
      return "git subcommand not allowed";
    }
  }
  return null;
}

export async function runAllowedGit(
  exec: CapsuleExec,
  cwd: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<GitRunResult> {
  const violation = gitArgvViolation(argv);
  if (violation !== null) {
    return { ok: false, detail: violation };
  }
  const result = await exec("git", argv, { cwd, env });
  if (result.code !== 0) {
    return { ok: false, detail: "git invocation failed" };
  }
  return { ok: true, stdout: result.stdout };
}

function isValidCapsuleSha(sha: string): boolean {
  return CAPSULE_SHA_PATTERN.test(sha);
}

export interface CapsuleProbeFsStat {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface CapsuleProbeFsReadHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  close(): Promise<void>;
}

export interface CapsuleProbeFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<CapsuleProbeFsStat>;
  lstat(path: string): Promise<CapsuleProbeFsStat>;
  access(path: string, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  open(path: string, flags?: string): Promise<CapsuleProbeFsReadHandle>;
}

export const defaultCapsuleProbeFs: CapsuleProbeFs = {
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  access: (p, mode) => fsp.access(p, mode),
  readdir: (p) => fsp.readdir(p),
  readFile: async (p) => new Uint8Array(await fsp.readFile(p)),
  open: async (p, flags) => {
    const handle = await fsp.open(p, flags);
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};

export function createCapsuleFsPort(fs: CapsuleProbeFs = defaultCapsuleProbeFs): FsPort {
  return {
    realpath: (absPath: string): Promise<string> => fs.realpath(absPath),
    stat: async (absPath: string): Promise<FsStat> => {
      const st = await fs.stat(absPath);
      const kind: FsStat["kind"] = st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
      return { kind, size: st.size };
    },
    read: async (absPath: string, opts: { maxBytes: number }): Promise<Uint8Array> => {
      const handle = await fs.open(absPath, "r");
      try {
        const buffer = new Uint8Array(opts.maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, opts.maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

export interface CapsuleGitPort {
  head(): Promise<string | null>;
  resolveSha(sha: string): Promise<string | null>;
}

export function createCapsuleGitPort(opts: {
  worktreeRoot: string;
  exec?: CapsuleExec;
  pathEnv?: string;
}): CapsuleGitPort {
  const exec = opts.exec ?? defaultCapsuleExec;
  const gitEnv = (): Readonly<Record<string, string>> => ({ PATH: capsulePathEnv(opts.pathEnv) });
  return {
    head: async (): Promise<string | null> => {
      const result = await runAllowedGit(
        exec,
        opts.worktreeRoot,
        ["rev-parse", "--verify", "HEAD"],
        gitEnv(),
      );
      return result.ok ? result.stdout.trim() : null;
    },
    resolveSha: async (sha: string): Promise<string | null> => {
      if (!isValidCapsuleSha(sha)) {
        return null;
      }
      const result = await runAllowedGit(
        exec,
        opts.worktreeRoot,
        ["cat-file", "-t", sha],
        gitEnv(),
      );
      return result.ok && result.stdout.trim() === "commit" ? sha : null;
    },
  };
}

export async function verifyCapsuleShas(
  git: CapsuleGitPort,
  req: { base_sha: string; dependency_shas: readonly string[] },
): Promise<{ ok: true } | CapsuleRefusal> {
  const head = await git.head();
  if (head === null || head !== req.base_sha) {
    return refusal("stale_base", `HEAD does not match base ${req.base_sha}`);
  }
  for (const sha of req.dependency_shas) {
    if ((await git.resolveSha(sha)) === null) {
      return refusal("missing_dependency", `dependency ${sha} not present`);
    }
  }
  return { ok: true };
}

function isContainedUnder(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(`${realRoot}/`);
}

async function realpathOrNull(fs: CapsuleProbeFs, target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

async function probeConfiguredPath(fs: CapsuleProbeFs, dir: string): Promise<PathProbeOutcome> {
  const real = await realpathOrNull(fs, dir);
  if (real === null) {
    return { status: "fail", detail: "configured directory unavailable" };
  }
  return { status: "ok", path: real };
}

async function isExecutableAt(fs: CapsuleProbeFs, candidate: string): Promise<boolean> {
  try {
    const st = await fs.stat(candidate);
    if (!st.isFile()) {
      return false;
    }
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeToolOnPath(
  fs: CapsuleProbeFs,
  name: string,
  pathValue: string,
): Promise<ProbeOutcome> {
  if (!TOOL_NAME_PATTERN.test(name)) {
    return { status: "fail", detail: `tool ${name} not available` };
  }
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) {
      continue;
    }
    if (await isExecutableAt(fs, path.join(dir, name))) {
      return { status: "ok" };
    }
  }
  return { status: "fail", detail: `tool ${name} not available` };
}

function defaultRuntimeVersions(): Record<string, string> {
  const candidates: [string, string | undefined][] = [
    ["bun", process.versions.bun],
    ["node", process.versions.node],
  ];
  const versions: Record<string, string> = {};
  for (const [name, version] of candidates) {
    if (version !== undefined) {
      versions[name] = version;
    }
  }
  return versions;
}

function probeRuntime(
  name: string,
  runtimeVersions: Readonly<Record<string, string>> | undefined,
): RuntimeProbeOutcome {
  const fail: RuntimeProbeOutcome = { status: "fail", detail: `runtime ${name} not available` };
  const versions = runtimeVersions ?? defaultRuntimeVersions();
  if (!Object.hasOwn(versions, name)) {
    return fail;
  }
  const version: unknown = versions[name];
  if (typeof version !== "string") {
    return fail;
  }
  return { status: "ok", version };
}

function artifactTarget(uri: string): string | null {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(uri) || /^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    return null;
  }
  if (uri.split("/").includes("..")) {
    return null;
  }
  return uri;
}

async function probeArtifactReadable(
  fs: CapsuleProbeFs,
  worktreeRoot: string,
  handle: ArtifactHandle,
): Promise<ProbeOutcome> {
  const target = artifactTarget(handle.uri);
  if (target === null) {
    return { status: "unknown", detail: "unsupported artifact uri" };
  }
  const realRoot = await realpathOrNull(fs, worktreeRoot);
  if (realRoot === null) {
    return { status: "fail", detail: "worktree root unavailable" };
  }
  const real = await realpathOrNull(fs, path.resolve(realRoot, target));
  if (real === null) {
    return { status: "fail", detail: "artifact path unavailable" };
  }
  if (!isContainedUnder(real, realRoot)) {
    return { status: "denied", detail: "artifact escapes worktree" };
  }
  return await probeReadableFile(fs, real);
}

async function probeReadableFile(fs: CapsuleProbeFs, real: string): Promise<ProbeOutcome> {
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) {
      return { status: "fail", detail: "artifact is not a regular file" };
    }
    await fs.access(real, fsConstants.R_OK);
    return { status: "ok" };
  } catch {
    return { status: "fail", detail: "artifact is not readable" };
  }
}

/**
 * Decides whether the git-reported hooks path is a repo-local deviation from
 * the default `.git/hooks`.
 *
 * The probe consults repo-local hook configuration only: git runs with a
 * PATH-only env and no HOME, so a global (~/.gitconfig) or XDG core.hooksPath
 * is deliberately ignored for hermeticity. This can disagree with
 * `WorktreeManager.readHooksPath`, which reads the effective value under the
 * operator's env; Phase 8 must reconcile the two before wiring this probe.
 *
 * The decision is lexical first — `path.resolve` is used here, never as a
 * containment check. Only when the lexical comparison mismatches do we try
 * realpath on both sides as an alias-only fallback; a realpath failure must
 * never by itself make the hooks "configured".
 */
async function resolveConfiguredHooksPath(
  fs: CapsuleProbeFs,
  root: string,
  gitPath: string,
  commonDir: string,
): Promise<string | null> {
  const defaultHooks = path.resolve(root, commonDir, "hooks");
  if (path.resolve(root, gitPath) === defaultHooks) {
    return null;
  }
  const [realGitPath, realDefaultHooks] = await Promise.all([
    realpathOrNull(fs, path.resolve(root, gitPath)),
    realpathOrNull(fs, defaultHooks),
  ]);
  if (realGitPath !== null && realGitPath === realDefaultHooks) {
    return null;
  }
  return gitPath;
}

export function createCapsuleProbePort(opts: {
  worktreeRoot: string;
  baseSha: string;
  storageRoot: string;
  operatorCheckout: string;
  exec?: CapsuleExec;
  fs?: CapsuleProbeFs;
  pathEnv?: string;
  runtimeVersions?: Readonly<Record<string, string>>;
}): ProbePort {
  const exec = opts.exec ?? defaultCapsuleExec;
  const fs = opts.fs ?? defaultCapsuleProbeFs;
  const git = createCapsuleGitPort({
    worktreeRoot: opts.worktreeRoot,
    exec,
    pathEnv: opts.pathEnv,
  });
  const gitEnv = (): Readonly<Record<string, string>> => ({ PATH: capsulePathEnv(opts.pathEnv) });

  async function trackedFiles(): Promise<string[] | null> {
    const result = await runAllowedGit(exec, opts.worktreeRoot, ["ls-files", "-z"], gitEnv());
    if (!result.ok) {
      return null;
    }
    return result.stdout.split(NUL).filter((file) => file !== "");
  }

  return {
    hasBase: async (): Promise<ProbeOutcome> => {
      const resolved = await git.resolveSha(opts.baseSha);
      return resolved === null
        ? { status: "fail", detail: "base commit not present" }
        : { status: "ok" };
    },
    hasCode: async (): Promise<ProbeOutcome> => {
      const files = await trackedFiles();
      if (files === null) {
        return { status: "fail", detail: "tracked file listing unavailable" };
      }
      return files.length > 0 ? { status: "ok" } : { status: "fail", detail: "no tracked files" };
    },
    hasTests: async (): Promise<ProbeOutcome> => {
      const files = await trackedFiles();
      if (files === null) {
        return { status: "fail", detail: "tracked file listing unavailable" };
      }
      return files.some((file) => TEST_PATH_PATTERN.test(file))
        ? { status: "ok" }
        : { status: "fail", detail: "no tracked test files" };
    },
    runtime: (name: string): Promise<RuntimeProbeOutcome> =>
      Promise.resolve(probeRuntime(name, opts.runtimeVersions)),
    pathTool: async (name: string): Promise<ProbeOutcome> =>
      await probeToolOnPath(fs, name, capsulePathEnv(opts.pathEnv)),
    storagePath: async (): Promise<PathProbeOutcome> =>
      await probeConfiguredPath(fs, opts.storageRoot),
    operatorCheckout: async (): Promise<PathProbeOutcome> =>
      await probeConfiguredPath(fs, opts.operatorCheckout),
    artifactReadable: async (handle: ArtifactHandle): Promise<ProbeOutcome> =>
      await probeArtifactReadable(fs, opts.worktreeRoot, handle),
    hookStatus: async (): Promise<HookProbeOutcome> => {
      const gitPathResult = await runAllowedGit(
        exec,
        opts.worktreeRoot,
        ["rev-parse", "--git-path", "hooks"],
        gitEnv(),
      );
      const commonDirResult = await runAllowedGit(
        exec,
        opts.worktreeRoot,
        ["rev-parse", "--git-common-dir"],
        gitEnv(),
      );
      if (!gitPathResult.ok || !commonDirResult.ok) {
        return { status: "unknown", detail: "hooks path unresolved" };
      }
      const configured = await resolveConfiguredHooksPath(
        fs,
        opts.worktreeRoot,
        gitPathResult.stdout.trim(),
        commonDirResult.stdout.trim(),
      );
      return { status: "ok", hooks: classifyGitHooks(opts.worktreeRoot, configured).status };
    },
  };
}
