import type { Readable, Writable } from "node:stream";

import { type ChildProcess, spawn } from "node:child_process";

import {
  type ExecLogger,
  type HostEnv,
  type HostTimers,
  requireEnv,
  requireFiniteMs,
  requireNonEmptyString,
  requireSignal,
} from "./host.js";

export type ExitOutcome = "exited" | "cancelled" | "watchdog" | "output-limit" | "spawn-error";

export interface ExitRecord {
  outcome: ExitOutcome;
  code: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
}

export interface SupervisedProcess {
  pid: number | undefined;
  pgid: number | undefined;
  stdin: Writable | undefined;
  stdout: Readable | undefined;
  stderr: Readable | undefined;
  spawnError: Error | null;
  exit: Promise<ExitRecord>;
  kill: (signal?: NodeJS.Signals) => void;
  cancel: () => void;
}

export interface SuperviseOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  watchdogMs: number;
  outputLimitBytes?: number;
  stdinMode?: "ignore" | "pipe";
  stdoutMode?: "pipe" | "raw";
  stderrMode?: "pipe" | "raw";
  logger?: ExecLogger;
  timers?: HostTimers;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exit: ExitRecord;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const CAPACITY_PATTERNS: { provider: string; re: RegExp }[] = [
  { provider: "google", re: /No capacity available for model ([\w.-]+)/ },
];

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  for (const p of CAPACITY_PATTERNS) {
    const m = p.re.exec(stderr);
    if (m) {
      return { provider: p.provider, model: m[1] ?? null, raw: m[0] };
    }
  }
  return null;
}

interface ArmedTimer {
  handle: unknown;
  fired: boolean;
}

function armTimer(timers: HostTimers, ms: number, fn: () => void): ArmedTimer {
  const timer: ArmedTimer = { handle: undefined, fired: false };
  timer.handle = timers.setTimeout(() => {
    timer.fired = true;
    fn();
  }, ms);
  return timer;
}

function disarmTimer(timers: HostTimers, timer: ArmedTimer | null): void {
  if (timer === null || timer.fired) return;
  timer.fired = true;
  timers.clearTimeout(timer.handle);
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGroupGone(pgid: number | undefined, timers: HostTimers): Promise<void> {
  if (pgid === undefined) return;
  for (let i = 0; i < 100; i += 1) {
    if (!groupExists(pgid)) return;
    await new Promise<void>((resolve) => {
      timers.setTimeout(resolve, 10);
    });
  }
}

interface SupervisorState {
  aborted: boolean;
  watchdogFired: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapped: boolean;
  stderrCapped: boolean;
  spawnError: Error | null;
  settled: boolean;
  watchdogTimer: ArmedTimer | null;
  cancelTimer: ArmedTimer | null;
}

interface NormalizedOpts {
  command: string;
  args: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  watchdogMs: number;
  outputLimitBytes: number;
  stdinMode: "ignore" | "pipe";
  stdoutPipe: boolean;
  stderrPipe: boolean;
  logger?: ExecLogger;
  timers: HostTimers;
  now: () => number;
}

function normalizeOptions(opts: SuperviseOptions): NormalizedOpts {
  const timers: HostTimers = {
    setTimeout:
      opts.timers?.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms)),
    clearTimeout:
      opts.timers?.clearTimeout ??
      ((h: unknown): void => {
        clearTimeout(h as Parameters<typeof clearTimeout>[0]);
      }),
    ...(opts.timers?.now !== undefined ? { now: opts.timers.now } : {}),
  };
  return {
    command: requireNonEmptyString(opts.command, "command"),
    args: opts.args ?? [],
    cwd: requireNonEmptyString(opts.cwd, "cwd"),
    env: requireEnv(opts.env, "env"),
    signal: requireSignal(opts.signal, "signal"),
    cancelGraceMs: requireFiniteMs(opts.cancelGraceMs, "cancelGraceMs", { min: 0 }),
    watchdogMs: requireFiniteMs(opts.watchdogMs, "watchdogMs", { min: 1 }),
    outputLimitBytes: opts.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    stdinMode: opts.stdinMode ?? "pipe",
    stdoutPipe: (opts.stdoutMode ?? "pipe") === "pipe",
    stderrPipe: (opts.stderrMode ?? "pipe") === "pipe",
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    timers,
    now: timers.now ?? ((): number => Date.now()),
  };
}

function buildExitPromise(
  proc: ChildProcess,
  state: SupervisorState,
  n: NormalizedOpts,
  pgid: number | undefined,
  spawnTs: number,
  onAbort: () => void,
): Promise<ExitRecord> {
  return new Promise<ExitRecord>((resolve) => {
    const finish = async (record: Omit<ExitRecord, "durationMs">): Promise<void> => {
      if (state.settled) return;
      state.settled = true;
      disarmTimer(n.timers, state.watchdogTimer);
      disarmTimer(n.timers, state.cancelTimer);
      n.signal.removeEventListener("abort", onAbort);
      if (record.outcome !== "exited" && record.outcome !== "spawn-error") {
        await waitGroupGone(pgid, n.timers);
      }
      resolve({ ...record, durationMs: Math.max(0, n.now() - spawnTs) });
    };

    proc.once("exit", () => {
      proc.stdin?.destroy();
    });
    proc.once("error", (err) => {
      state.spawnError = err;
      void finish({
        outcome: "spawn-error",
        code: null,
        signal: null,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    });
    proc.once("close", (code, closeSignal) => {
      const outcome: ExitOutcome = state.truncated
        ? "output-limit"
        : state.watchdogFired
          ? "watchdog"
          : state.aborted
            ? "cancelled"
            : "exited";
      void finish({
        outcome,
        code,
        signal: closeSignal,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    });
  });
}

function attachCapCounter(
  stream: Readable,
  state: SupervisorState,
  limit: number,
  which: "stdout" | "stderr",
  killGroup: (sig: NodeJS.Signals) => void,
  logger?: ExecLogger,
): void {
  stream.on("data", (chunk: Buffer | string) => {
    if (which === "stdout" ? state.stdoutCapped : state.stderrCapped) return;
    const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (which === "stdout") state.stdoutBytes += n;
    else state.stderrBytes += n;
    const observed = which === "stdout" ? state.stdoutBytes : state.stderrBytes;
    if (observed > limit) {
      if (which === "stdout") state.stdoutCapped = true;
      else state.stderrCapped = true;
      state.truncated = true;
      logger?.warn?.("process-supervisor: output limit exceeded; killing group", {
        stream: which,
        limit,
      });
      killGroup("SIGKILL");
    }
  });
  stream.resume();
}

export function superviseProcess(opts: SuperviseOptions): SupervisedProcess {
  const n = normalizeOptions(opts);
  const state: SupervisorState = {
    aborted: false,
    watchdogFired: false,
    truncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutCapped: false,
    stderrCapped: false,
    spawnError: null,
    settled: false,
    watchdogTimer: null,
    cancelTimer: null,
  };

  const proc = spawn(n.command, n.args, {
    cwd: n.cwd,
    env: n.env,
    stdio: [n.stdinMode, "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  const spawnTs = n.now();
  const pgid = process.platform !== "win32" ? proc.pid : undefined;

  const killGroup = (sig: NodeJS.Signals): void => {
    if (proc.pid === undefined) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-proc.pid, sig);
      } else {
        proc.kill(sig);
      }
    } catch {
      // Process may already be gone.
    }
  };

  const startCancelSequence = (): void => {
    if (state.cancelTimer !== null) return;
    killGroup("SIGTERM");
    state.cancelTimer = armTimer(n.timers, n.cancelGraceMs, () => {
      killGroup("SIGKILL");
    });
  };
  const onAbort = (): void => {
    state.aborted = true;
    startCancelSequence();
  };

  const exit = buildExitPromise(proc, state, n, pgid, spawnTs, onAbort);

  if (n.stdoutPipe && proc.stdout !== null) {
    attachCapCounter(proc.stdout, state, n.outputLimitBytes, "stdout", killGroup, n.logger);
  }
  if (n.stderrPipe && proc.stderr !== null) {
    attachCapCounter(proc.stderr, state, n.outputLimitBytes, "stderr", killGroup, n.logger);
  }

  if (n.signal.aborted) {
    onAbort();
  } else {
    n.signal.addEventListener("abort", onAbort, { once: true });
  }
  state.watchdogTimer = armTimer(n.timers, n.watchdogMs, () => {
    state.watchdogFired = true;
    killGroup("SIGKILL");
  });
  // The watchdog is advisory supervision, not a keepalive — never hold the loop open.
  const rawHandle = state.watchdogTimer.handle;
  if (typeof rawHandle === "object" && rawHandle !== null && "unref" in rawHandle) {
    (rawHandle as { unref: () => void }).unref();
  }

  return {
    pid: proc.pid,
    pgid,
    stdin: proc.stdin ?? undefined,
    stdout: proc.stdout ?? undefined,
    stderr: proc.stderr ?? undefined,
    get spawnError(): Error | null {
      return state.spawnError;
    },
    exit,
    kill: (sig: NodeJS.Signals = "SIGKILL"): void => {
      killGroup(sig);
    },
    cancel: (): void => {
      state.aborted = true;
      startCancelSequence();
    },
  };
}

export async function runProcess(opts: SuperviseOptions): Promise<RunProcessResult> {
  const proc = superviseProcess({ ...opts, stdinMode: opts.stdinMode ?? "ignore" });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  const exit = await proc.exit;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exit,
  };
}
