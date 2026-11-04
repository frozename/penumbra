import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { defaultRunCommand, isSafeRelativePath, type RunCommand } from "./materialize.js";

export type SandboxKind = "none" | "darwin-sbx" | "linux-bwrap";

type ActiveSandbox = Exclude<SandboxKind, "none">;

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export const GRADER_DIR = dirname(fileURLToPath(import.meta.url));

const PROBE_FD3 = Symbol("penumbra.probe-fd3");

export interface ProbeSpawnOptions extends SpawnOptionsWithoutStdio {
  [PROBE_FD3]?: string;
}

export type SpawnFn = (cmd: string, args: string[], opts?: ProbeSpawnOptions) => ChildProcess;

export interface ProbeLegCall {
  id: string;
  export: string;
  input: unknown;
}

export interface ProbeLeg {
  module_rel: string;
  calls: ProbeLegCall[];
}

export interface LegCallOk {
  id: string;
  output: unknown;
}

export interface LegCallError {
  id: string;
  error: string;
}

export type LegCallResult = LegCallOk | LegCallError;

export type LegResult =
  | { kind: "ok"; results: LegCallResult[] }
  | { kind: string; results: LegCallResult[] }
  | { kind: "timeout" }
  | { kind: "no_output" }
  | { kind: "tamper" };

export interface DetectSandboxOptions {
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
  runCommand?: RunCommand;
  bun?: string;
}

export interface SandboxDirs {
  bun: string;
  graderDir: string;
  treeDir: string;
  depsDir: string;
  legTmp: string;
}

export interface SandboxArgv {
  cmd: string;
  args: string[];
}

export interface ProbeDirs {
  treeDir: string;
  depsDir: string;
}

export interface RunProbeLegOptions {
  sandbox: SandboxKind;
  leg: ProbeLeg;
  timeoutMs: number;
  dirs: ProbeDirs;
  spawn: SpawnFn | undefined;
  bun?: string;
  tmpRoot?: string;
}

interface Fd3State {
  chunks: Buffer[];
  bytes: number;
  overflow: boolean;
  timedOut: boolean;
  streamAttached: boolean;
}

const FD3_LIMIT_BYTES = 1024 * 1024;
const FD3_FILE_NAME = "fd3.out";
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const BWRAP_CMD = "bwrap";

const HARNESS_ARGS = [
  "--no-install",
  "--no-env-file",
  `--config=${join(GRADER_DIR, "bunfig.toml")}`,
  join(GRADER_DIR, "probe-harness.ts"),
];

const defaultWhich = (name: string): string | null => Bun.which(name);

export function bunPrefix(bun: string): string {
  return realpathSync(dirname(dirname(realpathSync(bun))));
}

function probeEnv(bunDir: string, legTmp: string): NodeJS.ProcessEnv {
  return {
    PATH: bunDir,
    HOME: legTmp,
    TMPDIR: legTmp,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
}

function darwinArgv(dirs: SandboxDirs, bunArgs: string[]): SandboxArgv {
  const bun = realpathSync(dirs.bun);
  return {
    cmd: SANDBOX_EXEC_PATH,
    args: [
      "-f",
      join(dirs.graderDir, "sandbox-darwin.sb"),
      "-D",
      `GRADER=${realpathSync(dirs.graderDir)}`,
      "-D",
      `TREE=${realpathSync(dirs.treeDir)}`,
      "-D",
      `DEPS=${realpathSync(dirs.depsDir)}`,
      "-D",
      `BUN=${bun}`,
      "-D",
      `BUNPREFIX=${bunPrefix(dirs.bun)}`,
      "-D",
      `TMP=${realpathSync(dirs.legTmp)}`,
      bun,
      ...bunArgs,
    ],
  };
}

function linuxArgv(dirs: SandboxDirs, bunArgs: string[]): SandboxArgv {
  const bun = realpathSync(dirs.bun);
  const grader = realpathSync(dirs.graderDir);
  const legTmp = realpathSync(dirs.legTmp);
  const tree = realpathSync(dirs.treeDir);
  const deps = realpathSync(dirs.depsDir);
  const prefix = bunPrefix(dirs.bun);
  return {
    cmd: BWRAP_CMD,
    args: [
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      tree,
      tree,
      "--ro-bind",
      grader,
      grader,
      "--ro-bind",
      deps,
      deps,
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind",
      prefix,
      prefix,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      legTmp,
      legTmp,
      "--clearenv",
      "--setenv",
      "PATH",
      dirname(bun),
      "--setenv",
      "HOME",
      legTmp,
      "--setenv",
      "TMPDIR",
      legTmp,
      "--setenv",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
      "0",
      "--chdir",
      grader,
      bun,
      ...bunArgs,
    ],
  };
}

export function sandboxArgv(kind: SandboxKind, dirs: SandboxDirs, bunArgs: string[]): SandboxArgv {
  if (kind === "darwin-sbx") {
    return darwinArgv(dirs, bunArgs);
  }
  if (kind === "linux-bwrap") {
    return linuxArgv(dirs, bunArgs);
  }
  return { cmd: dirs.bun, args: bunArgs };
}

async function smokeSandbox(
  kind: ActiveSandbox,
  bun: string,
  runCommand: RunCommand,
): Promise<SandboxKind> {
  const treeDir = realpathSync(mkdtempSync(join(tmpdir(), "probe-smoke-tree-")));
  const depsDir = realpathSync(mkdtempSync(join(tmpdir(), "probe-smoke-deps-")));
  const legTmp = realpathSync(mkdtempSync(join(tmpdir(), "probe-smoke-tmp-")));
  try {
    const argv = sandboxArgv(kind, { bun, graderDir: GRADER_DIR, treeDir, depsDir, legTmp }, [
      "-e",
      "0",
    ]);
    const res = await runCommand(argv.cmd, argv.args, {
      cwd: GRADER_DIR,
      env: probeEnv(dirname(bun), legTmp),
    });
    return res.code === 0 ? kind : "none";
  } catch {
    return "none";
  } finally {
    rmSync(treeDir, { recursive: true, force: true });
    rmSync(depsDir, { recursive: true, force: true });
    rmSync(legTmp, { recursive: true, force: true });
  }
}

export async function detectSandbox(opts: DetectSandboxOptions = {}): Promise<SandboxKind> {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? defaultWhich;
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const bun = opts.bun ?? process.execPath;
  if (platform === "darwin") {
    if (which("sandbox-exec") === null) {
      return "none";
    }
    return await smokeSandbox("darwin-sbx", bun, runCommand);
  }
  if (platform === "linux") {
    if (which(BWRAP_CMD) === null) {
      return "none";
    }
    return await smokeSandbox("linux-bwrap", bun, runCommand);
  }
  return "none";
}

export async function requireSandbox(opts: DetectSandboxOptions = {}): Promise<ActiveSandbox> {
  const kind = await detectSandbox(opts);
  if (kind === "none") {
    throw new SandboxUnavailableError(`no OS sandbox available (platform=${process.platform})`);
  }
  return kind;
}

function buildPayload(nonce: string, leg: ProbeLeg, treeDir: string): string {
  return JSON.stringify({
    nonce,
    module_rel: leg.module_rel,
    tree: treeDir,
    calls: leg.calls.map((call) => ({ id: call.id, export: call.export, input: call.input })),
  });
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

// The default spawn routes fd 3 to a real file, not a pipe: Bun's
// node:child_process polyfill wraps pipe fds >= 3 in net.Socket via
// connect({fd}), which races child exit and intermittently fails ENOENT,
// losing the frame and emitting an unhandled Socket 'error'. The file is
// opened write-only + append: the child cannot pread the nonce over the fd
// nor rewrite a committed frame, only append (which classifyFd3 rejects as a
// multi-line tamper). The file lives in a parent-only directory that is not
// bound into the sandbox and not referenced in the profile or bwrap argv; the
// child sees the inherited fd only.
const defaultProbeSpawn: SpawnFn = (cmd, args, opts) => {
  const fd3Path = opts?.[PROBE_FD3];
  const baseStdio = opts?.stdio;
  if (fd3Path === undefined || !Array.isArray(baseStdio) || baseStdio.length < 4) {
    return spawn(cmd, args, { cwd: opts?.cwd, env: opts?.env, stdio: baseStdio });
  }
  const fd3 = openSync(fd3Path, "a");
  try {
    const stdio = baseStdio.map((entry, i) => (i === 3 ? fd3 : entry));
    return spawn(cmd, args, { cwd: opts?.cwd, env: opts?.env, stdio });
  } finally {
    closeSync(fd3);
  }
};

function attachFd3(child: ChildProcess, state: Fd3State): void {
  const fd3 = child.stdio[3] as Readable | null | undefined;
  if (fd3 === null || fd3 === undefined || typeof fd3.on !== "function") {
    return;
  }
  state.streamAttached = true;
  fd3.on("data", (chunk: Buffer) => {
    if (state.overflow) {
      return;
    }
    state.bytes += chunk.length;
    if (state.bytes > FD3_LIMIT_BYTES) {
      state.overflow = true;
      killChild(child);
      return;
    }
    state.chunks.push(chunk);
  });
}

function readFd3File(path: string, state: Fd3State): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      return Buffer.alloc(0);
    }
    if (size > FD3_LIMIT_BYTES) {
      state.overflow = true;
      return Buffer.alloc(1);
    }
    const buf = Buffer.alloc(size);
    const bytes = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

function parseLegEntry(entry: unknown, call: ProbeLegCall | undefined): LegCallResult | null {
  if (call === undefined || typeof entry !== "object" || entry === null) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  if (Object.keys(rec).length !== 2 || rec.id !== call.id) {
    return null;
  }
  if ("output" in rec) {
    return { id: call.id, output: rec.output };
  }
  if (typeof rec.error === "string") {
    return { id: call.id, error: rec.error };
  }
  return null;
}

function parseLegResults(json: string, leg: ProbeLeg): LegCallResult[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== leg.calls.length) {
    return null;
  }
  const items: unknown[] = parsed;
  const results: LegCallResult[] = [];
  for (const [i, entry] of items.entries()) {
    const result = parseLegEntry(entry, leg.calls[i]);
    if (result === null) {
      return null;
    }
    results.push(result);
  }
  return results;
}

function classifyFd3(buf: Buffer, nonce: string, leg: ProbeLeg, state: Fd3State): LegResult {
  if (state.timedOut) {
    return { kind: "timeout" };
  }
  if (state.overflow) {
    // Checked before the empty-buffer branch: a stream spawn can cross the
    // cap in a single chunk, leaving nothing accepted but the overflow flag.
    return { kind: "tamper" };
  }
  if (buf.length === 0) {
    return { kind: "no_output" };
  }
  const text = buf.toString("utf8");
  if (!text.endsWith("\n")) {
    return { kind: "tamper" };
  }
  const line = text.slice(0, -1);
  if (line.includes("\n") || !line.startsWith(`${nonce} `)) {
    return { kind: "tamper" };
  }
  const results = parseLegResults(line.slice(nonce.length + 1), leg);
  return results === null ? { kind: "tamper" } : { kind: "ok", results };
}

function runLegChild(
  opts: RunProbeLegOptions,
  bun: string,
  spawnFn: SpawnFn,
  legTmp: string,
  fd3Path: string,
): Promise<LegResult> {
  const nonce = randomBytes(16).toString("hex");
  const payload = buildPayload(nonce, opts.leg, opts.dirs.treeDir);
  const argv = sandboxArgv(
    opts.sandbox,
    {
      bun,
      graderDir: GRADER_DIR,
      treeDir: opts.dirs.treeDir,
      depsDir: opts.dirs.depsDir,
      legTmp,
    },
    HARNESS_ARGS,
  );
  return new Promise<LegResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(argv.cmd, argv.args, {
        cwd: GRADER_DIR,
        env: probeEnv(dirname(bun), legTmp),
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        [PROBE_FD3]: fd3Path,
      });
    } catch {
      resolve({ kind: "no_output" });
      return;
    }
    const state: Fd3State = {
      chunks: [],
      bytes: 0,
      overflow: false,
      timedOut: false,
      streamAttached: false,
    };
    attachFd3(child, state);
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.on("error", () => undefined);
    const timer = setTimeout(() => {
      state.timedOut = true;
      killChild(child);
    }, opts.timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ kind: "no_output" });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const buf = state.streamAttached ? Buffer.concat(state.chunks) : readFd3File(fd3Path, state);
      resolve(classifyFd3(buf, nonce, opts.leg, state));
    });
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      /* destroyed stdin: the child's 'close'/'error' resolves */
    }
  });
}

export async function runProbeLeg(opts: RunProbeLegOptions): Promise<LegResult> {
  if (!isSafeRelativePath(opts.leg.module_rel)) {
    throw new Error(`runProbeLeg: unsafe module_rel ${opts.leg.module_rel}`);
  }
  const scratch = opts.tmpRoot ?? tmpdir();
  // The frame file lives in its own mkdtemp (0700) directory, a sibling of
  // the leg HOME: legTmp is bound read-write under bwrap and writable under
  // seatbelt, so a frame inside legTmp would be readable (nonce leak) and
  // renamable by the candidate.
  const legTmp = realpathSync(mkdtempSync(join(scratch, "probe-leg-")));
  const fd3Dir = realpathSync(mkdtempSync(join(scratch, "probe-fd3-")));
  try {
    return await runLegChild(
      opts,
      opts.bun ?? process.execPath,
      opts.spawn ?? defaultProbeSpawn,
      legTmp,
      join(fd3Dir, FD3_FILE_NAME),
    );
  } finally {
    rmSync(legTmp, { recursive: true, force: true });
    rmSync(fd3Dir, { recursive: true, force: true });
  }
}
