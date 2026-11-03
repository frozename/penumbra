import type { HeavyJobGate } from "@penumbra/core";

import { isResourceKill, wrapResourceScopeArgv } from "@penumbra/core";
import { existsSync } from "node:fs";

export type HeavyCommandClass = "lint" | "typecheck" | "test" | "build";

const SHELL_BASENAMES = new Set(["bash", "sh", "zsh", "dash"]);
const INFO_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION_RE = /^\d+(?:\.\d+)?(?:ms|[smhdw])?$/;
const SINGLE_WRAPPERS = new Set(["env", "nice", "npx", "bunx"]);
const TWO_TOKEN_WRAPPERS = new Map<string, ReadonlySet<string>>([
  ["pnpm", new Set(["exec", "dlx"])],
  ["yarn", new Set(["dlx"])],
  ["bun", new Set(["x", "exec"])],
]);
const DIRECT_CLASS = new Map<string, HeavyCommandClass>([
  ["eslint", "lint"],
  ["tsc", "typecheck"],
  ["vue-tsc", "typecheck"],
  ["vitest", "test"],
  ["jest", "test"],
]);

function basename(token: string): string {
  const idx = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return idx >= 0 ? token.slice(idx + 1) : token;
}

function isDashCFlag(token: string | undefined): boolean {
  return token !== undefined && token.length >= 2 && token.startsWith("-") && token.endsWith("c");
}

function splitScript(script: string): string[][] {
  return script
    .replaceAll(/&&|\|\||[;|\n\r]/g, "\n")
    .split("\n")
    .map((seg) => seg.split(/\s+/).filter(Boolean))
    .filter((seg) => seg.length > 0);
}

const SCRIPT_CLASS = new Map<string, HeavyCommandClass>([
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["type-check", "typecheck"],
  ["tsc", "typecheck"],
  ["check", "typecheck"],
  ["test", "test"],
  ["build", "build"],
]);

function mapScriptName(script: string | undefined): HeavyCommandClass | null {
  if (script === undefined) return null;
  return SCRIPT_CLASS.get(script.split(":")[0] ?? "") ?? null;
}

/** Advances past one leading wrapper token pair; returns -1 when none matches. */
function stripStep(tokens: readonly string[], i: number): number {
  const t = tokens[i] ?? "";
  if (ASSIGNMENT_RE.test(t) || SINGLE_WRAPPERS.has(t)) return i + 1;
  if (t === "timeout") {
    const next = tokens[i + 1];
    return next !== undefined && DURATION_RE.test(next) ? i + 2 : i + 1;
  }
  const next = tokens[i + 1];
  if (next !== undefined && (TWO_TOKEN_WRAPPERS.get(t)?.has(next) ?? false)) return i + 2;
  return -1;
}

function skipWrappers(tokens: readonly string[]): number {
  let i = 0;
  for (;;) {
    const next = stripStep(tokens, i);
    if (next < 0) return i;
    i = next;
  }
}

function matchBunOrNpm(head: string, rest: string[]): HeavyCommandClass | null {
  if (head !== "bun" && head !== "npm") return null;
  if (rest[1] === "test") return "test";
  return rest[1] === "run" ? mapScriptName(rest[2]) : null;
}

function matchPackageRunner(head: string, rest: string[]): HeavyCommandClass | null {
  if (head !== "pnpm" && head !== "yarn") return null;
  const sub = rest[1];
  if (sub === undefined) return null;
  return mapScriptName(sub === "run" ? rest[2] : sub);
}

function matchRunner(head: string, rest: string[]): HeavyCommandClass | null {
  return matchBunOrNpm(head, rest) ?? matchPackageRunner(head, rest);
}

function classifySegment(tokens: readonly string[]): HeavyCommandClass | null {
  const start = skipWrappers(tokens);
  const rest = tokens.slice(start);
  if (rest.length === 0 || rest.some((tok) => INFO_FLAGS.has(tok))) return null;
  const head = basename(rest[0] ?? "");
  return DIRECT_CLASS.get(head) ?? matchRunner(head, rest);
}

function segmentsOf(argv: readonly string[]): readonly (readonly string[])[] {
  const first = argv[0];
  if (first === undefined || !SHELL_BASENAMES.has(basename(first)) || !isDashCFlag(argv[1])) {
    return [argv];
  }
  return splitScript(argv[2] ?? "");
}

/**
 * Classify a spawn argv as a heavy repo command (lint / typecheck / test /
 * build) or null. Pure: no I/O. Shell `-c` scripts are split into segments on
 * `&&`, `||`, `;`, `|` and newlines; the first heavy segment wins.
 */
export function classifyHeavyCommand(argv: readonly string[]): HeavyCommandClass | null {
  for (const seg of segmentsOf(argv)) {
    const jobClass = classifySegment(seg);
    if (jobClass !== null) return jobClass;
  }
  return null;
}

export interface SpawnSandboxedOpts {
  argv?: string[];
  cmd?: string;
  cwd: string;
  envOverride?: Record<string, string>;
  timeoutMs: number;
  outputMaxBytes: number;
  signal?: AbortSignal;
  /** Override the sandbox PATH; default '/usr/bin:/bin' */
  path?: string;
  /**
   * Seatbelt (sandbox-exec -p) profile text. When set, the child is spawned
   * via /usr/bin/sandbox-exec — the OS write-deny backstop for permission
   * profile dispatches. Fails closed via SandboxUnavailableError when
   * sandbox-exec is unavailable; an unsandboxed profile spawn is never run.
   */
  sandboxProfile?: string;
  /**
   * When the command classifies as heavy (see classifyHeavyCommand), the spawn
   * first waits on the host-wide heavy-job lock and the memory floor, so
   * agent-run lint/typecheck/test/build commands queue behind reconciler stages
   * instead of driving the host into a global OOM (penumbra#250).
   */
  heavyJobGate?: HeavyJobGate;
}

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Assert sandbox-exec can be spawned. Fails closed: a profile dispatch on a
 * platform without sandbox-exec must refuse rather than silently run
 * unsandboxed. `platform`/`exists` are injectable for tests.
 */
export function assertSandboxExecAvailable(deps?: {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): void {
  const platform = deps?.platform ?? process.platform;
  const exists = deps?.exists ?? existsSync;
  if (platform !== "darwin" || !exists(SANDBOX_EXEC_PATH)) {
    throw new SandboxUnavailableError(
      `sandbox-exec unavailable (platform=${platform}); refusing permission-profile spawn unsandboxed`,
    );
  }
}

/**
 * Wrap an argv in `sandbox-exec -p <profile>`. Fails closed via
 * assertSandboxExecAvailable. `platform`/`exists` are injectable for tests.
 */
export function wrapSandboxExecArgv(
  argv: string[],
  profile: string,
  deps?: { platform?: NodeJS.Platform; exists?: (path: string) => boolean },
): string[] {
  assertSandboxExecAvailable(deps);
  return [SANDBOX_EXEC_PATH, "-p", profile, ...argv];
}

export interface SpawnSandboxedResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  argv: string[];
  envKeys: string[];
  /** "resource": SIGKILLed by something other than Penumbra — a scope MemoryMax or host OOM kill. */
  killReason?: "timeout" | "output_overflow" | "cancelled" | "resource";
}

type Subprocess = ReturnType<typeof Bun.spawn>;

const BASE_ENV_KEYS = ["PATH", "HOME", "CI", "TERM"] as const;
const PASS_THROUGH_ENV_KEYS = ["LANG", "LC_ALL"] as const;

function isExecutableMissingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return /Executable not found/i.test(message);
}

function buildSandboxEnv(opts: SpawnSandboxedOpts): Record<string, string> {
  const env: Record<string, string> = {
    PATH: opts.path ?? "/usr/bin:/bin",
    HOME: opts.cwd,
    CI: "true",
    TERM: "dumb",
  };
  for (const key of PASS_THROUGH_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(opts.envOverride ?? {})) env[k] = v;
  return env;
}

/**
 * Returns the env var names the sandbox will expose to a child, matching
 * buildSandboxEnv's shape without the values. Kept in lockstep with
 * buildSandboxEnv via shared BASE_ENV_KEYS / PASS_THROUGH_ENV_KEYS constants so
 * security-audit events cannot silently drift from the real spawn env.
 */
export function computeSandboxEnvKeys(envOverride?: Record<string, string>): string[] {
  const keys = new Set<string>(BASE_ENV_KEYS);
  for (const key of PASS_THROUGH_ENV_KEYS) {
    if (process.env[key] !== undefined) keys.add(key);
  }
  for (const key of Object.keys(envOverride ?? {})) keys.add(key);
  return [...keys];
}

function killProc(proc: Subprocess): ReturnType<typeof setTimeout> | undefined {
  const kill = (signal: NodeJS.Signals): void => {
    const pid = proc.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        /* process group may already be gone */
      }
    }
    try {
      proc.kill(signal);
    } catch {
      /* signal delivery may race with natural exit */
    }
  };

  kill("SIGTERM");
  return setTimeout(() => {
    kill("SIGKILL");
  }, 2000);
}

function clearKillEscalation(handle: ReturnType<typeof setTimeout> | undefined): void {
  if (handle) clearTimeout(handle);
}

function replaceKillEscalation(
  current: ReturnType<typeof setTimeout> | undefined,
  proc: Subprocess,
): ReturnType<typeof setTimeout> | undefined {
  clearKillEscalation(current);
  return killProc(proc);
}

async function readStream(
  s: ReadableStream<Uint8Array> | null,
  ingest: (c: string) => void,
): Promise<void> {
  if (!s) return;
  const reader = s.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ingest(dec.decode(value, { stream: true }));
    }
    const tail = dec.decode();
    if (tail) ingest(tail);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* releaseLock may throw if stream already finalized */
    }
  }
}

export async function spawnSandboxed(opts: SpawnSandboxedOpts): Promise<SpawnSandboxedResult> {
  if (!opts.argv && !opts.cmd) throw new Error("spawnSandboxed: argv or cmd required");

  const innerArgv = opts.argv ?? ["bash", "-c", opts.cmd ?? ""];
  const env = buildSandboxEnv(opts);
  // sandbox-exec (macOS) runs inside the memory scope (Linux); the two never
  // coexist on one host today, but the order keeps the cap outermost.
  const argv = wrapResourceScopeArgv(
    opts.sandboxProfile !== undefined
      ? wrapSandboxExecArgv(innerArgv, opts.sandboxProfile)
      : innerArgv,
    { label: "terminal", childEnv: env },
  );
  const envKeys = Object.keys(env);

  const jobClass = opts.heavyJobGate ? classifyHeavyCommand(innerArgv) : null;
  if (!opts.heavyJobGate || jobClass === null) {
    return await runSpawned(opts, argv, env, envKeys);
  }

  const entry = await opts.heavyJobGate.enter(`terminal-${jobClass}`, opts.signal);
  if (!entry.ok) {
    return {
      exitCode: 1,
      signal: null,
      output: `penumbra: ${jobClass} command not started: ${entry.reason}\n`,
      truncated: false,
      durationMs: 0,
      argv,
      envKeys,
      killReason: opts.signal?.aborted ? "cancelled" : "resource",
    };
  }
  try {
    return await runSpawned(opts, argv, env, envKeys);
  } finally {
    await entry.release();
  }
}

async function runSpawned(
  opts: SpawnSandboxedOpts,
  argv: string[],
  env: Record<string, string>,
  envKeys: string[],
): Promise<SpawnSandboxedResult> {
  const start = performance.now();
  let proc: Subprocess;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    if (isExecutableMissingError(err)) {
      return {
        exitCode: 127,
        signal: null,
        output: "",
        truncated: false,
        durationMs: Math.round(performance.now() - start),
        argv,
        envKeys,
      };
    }
    throw err;
  }

  let buf = "";
  let truncated = false;
  let killReason: SpawnSandboxedResult["killReason"];
  let killEscalationHandle: ReturnType<typeof setTimeout> | undefined;

  const ingest = (chunk: string): void => {
    if (truncated) return;
    const currentBytes = Buffer.byteLength(buf, "utf8");
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (currentBytes + chunkBytes > opts.outputMaxBytes) {
      const remaining = opts.outputMaxBytes - currentBytes;
      buf += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
      killReason = "output_overflow";
      killEscalationHandle = replaceKillEscalation(killEscalationHandle, proc);
      return;
    }
    buf += chunk;
  };

  const timeoutHandle = setTimeout(() => {
    if (proc.exitCode !== null) return;
    killReason ??= "timeout";
    killEscalationHandle = replaceKillEscalation(killEscalationHandle, proc);
  }, opts.timeoutMs);

  const onAbort = (): void => {
    if (proc.exitCode !== null) return;
    killReason ??= "cancelled";
    killEscalationHandle = replaceKillEscalation(killEscalationHandle, proc);
  };

  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array> | null, ingest),
      readStream(proc.stderr as ReadableStream<Uint8Array> | null, ingest),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
    clearKillEscalation(killEscalationHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  const durationMs = Math.round(performance.now() - start);
  const exitCode = proc.exitCode ?? -1;
  const sig = proc.signalCode ?? null;

  return {
    exitCode,
    signal: sig,
    output: buf,
    truncated,
    durationMs,
    argv,
    envKeys,
    killReason: killReason ?? resourceKillReason(proc.exitCode, sig),
  };
}

function resourceKillReason(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): "resource" | undefined {
  return isResourceKill({ exitCode, signal }) ? "resource" : undefined;
}
