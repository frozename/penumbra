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
  stderrTail: string;
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

export type SupervisorSignalReason =
  | "abort"
  | "grace-expired"
  | "watchdog"
  | "output-limit"
  | "cancel"
  | "kill";

export type SupervisorEvent =
  | { type: "spawn"; pid: number | undefined }
  | { type: "signal"; signal: NodeJS.Signals; reason: SupervisorSignalReason }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; outcome: ExitOutcome };

export interface SuperviseOptions {
  command: string;
  args: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  watchdogMs: number;
  /** Child stdin: a string is written verbatim then closed; "ignore" attaches
   * /dev/null; omitted leaves the stdio pipe open for `handle.stdin`. */
  stdin?: string | "ignore";
  /** Per-stream output cap in bytes; absent means uncapped. */
  outputLimitBytes?: number;
  /** Trailing stderr bytes retained on `ExitRecord.stderrTail`. */
  stderrTailBytes?: number;
  stdoutMode?: "pipe" | "raw";
  stderrMode?: "pipe" | "raw";
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onProcessEvent?: (event: SupervisorEvent) => void;
  logger?: ExecLogger;
  timers?: HostTimers;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exit: ExitRecord;
}

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  const patterns: { provider: string; re: RegExp }[] = [
    { provider: "google", re: /No capacity available for model ([\w.-]+)/ },
  ];
  for (const p of patterns) {
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

async function waitGroupGone(pgid: number | undefined, timers: HostTimers): Promise<void> {
  if (pgid === undefined) return;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
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
  stderrTail: Buffer;
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
  stdin: string | "ignore" | "pipe";
  outputLimitBytes: number | undefined;
  stderrTailBytes: number | undefined;
  stdoutPipe: boolean;
  stderrPipe: boolean;
  onStdoutChunk: ((chunk: Buffer) => void) | undefined;
  onStderrChunk: ((chunk: Buffer) => void) | undefined;
  onLine: ((line: string, stream: "stdout" | "stderr") => void) | undefined;
  onProcessEvent: ((event: SupervisorEvent) => void) | undefined;
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
    args: opts.args,
    cwd: requireNonEmptyString(opts.cwd, "cwd"),
    env: requireEnv(opts.env, "env"),
    signal: requireSignal(opts.signal, "signal"),
    cancelGraceMs: requireFiniteMs(opts.cancelGraceMs, "cancelGraceMs", { min: 0 }),
    watchdogMs: requireFiniteMs(opts.watchdogMs, "watchdogMs", { min: 1 }),
    stdin: opts.stdin ?? "pipe",
    outputLimitBytes:
      opts.outputLimitBytes === undefined
        ? undefined
        : requireFiniteMs(opts.outputLimitBytes, "outputLimitBytes", { min: 1 }),
    stderrTailBytes:
      opts.stderrTailBytes === undefined
        ? undefined
        : requireFiniteMs(opts.stderrTailBytes, "stderrTailBytes", { min: 0 }),
    stdoutPipe: (opts.stdoutMode ?? "pipe") === "pipe",
    stderrPipe: (opts.stderrMode ?? "pipe") === "pipe",
    onStdoutChunk: opts.onStdoutChunk,
    onStderrChunk: opts.onStderrChunk,
    onLine: opts.onLine,
    onProcessEvent: opts.onProcessEvent,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    timers,
    now: timers.now ?? ((): number => Date.now()),
  };
}

interface StreamLineState {
  pending: string;
}

function attachStreamHandler(
  stream: Readable,
  state: SupervisorState,
  n: NormalizedOpts,
  which: "stdout" | "stderr",
  lineState: StreamLineState,
  killGroup: (sig: NodeJS.Signals, reason: SupervisorSignalReason) => void,
): void {
  stream.on("data", (chunk: Buffer | string) => {
    if (which === "stdout" ? state.stdoutCapped : state.stderrCapped) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (which === "stdout") state.stdoutBytes += buf.length;
    else state.stderrBytes += buf.length;
    if (which === "stderr" && n.stderrTailBytes !== undefined) {
      state.stderrTail = Buffer.concat([state.stderrTail, buf]);
      if (state.stderrTail.length > n.stderrTailBytes) {
        state.stderrTail = state.stderrTail.subarray(state.stderrTail.length - n.stderrTailBytes);
      }
    }
    if (which === "stdout") n.onStdoutChunk?.(buf);
    else n.onStderrChunk?.(buf);
    if (n.onLine !== undefined) {
      lineState.pending += buf.toString("utf8");
      let idx: number;
      while ((idx = lineState.pending.indexOf("\n")) !== -1) {
        const line = lineState.pending.slice(0, idx);
        lineState.pending = lineState.pending.slice(idx + 1);
        n.onLine(line.replace(/\r$/, ""), which);
      }
    }
    if (n.outputLimitBytes !== undefined) {
      const observed = which === "stdout" ? state.stdoutBytes : state.stderrBytes;
      if (observed > n.outputLimitBytes) {
        if (which === "stdout") state.stdoutCapped = true;
        else state.stderrCapped = true;
        state.truncated = true;
        n.logger?.warn?.("process-supervisor: output limit exceeded; killing group", {
          stream: which,
          limit: n.outputLimitBytes,
        });
        killGroup("SIGKILL", "output-limit");
      }
    }
  });
  stream.on("end", () => {
    if (n.onLine !== undefined && lineState.pending.length > 0) {
      n.onLine(lineState.pending, which);
      lineState.pending = "";
    }
  });
  stream.resume();
}

function cancelledProcess(): SupervisedProcess {
  const exit = Promise.resolve<ExitRecord>({
    outcome: "cancelled",
    code: null,
    signal: null,
    truncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrTail: "",
    durationMs: 0,
  });
  return {
    pid: undefined,
    pgid: undefined,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    spawnError: null,
    exit,
    kill: () => {},
    cancel: () => {},
  };
}

export function superviseProcess(opts: SuperviseOptions): SupervisedProcess {
  const n = normalizeOptions(opts);
  if (n.signal.aborted) {
    return cancelledProcess();
  }
  const state: SupervisorState = {
    aborted: false,
    watchdogFired: false,
    truncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrTail: Buffer.alloc(0),
    stdoutCapped: false,
    stderrCapped: false,
    spawnError: null,
    settled: false,
    watchdogTimer: null,
    cancelTimer: null,
  };

  const proc: ChildProcess = spawn(n.command, n.args, {
    cwd: n.cwd,
    env: n.env,
    stdio: [n.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  const spawnTs = n.now();
  const pgid = process.platform !== "win32" ? proc.pid : undefined;

  const killGroup = (sig: NodeJS.Signals, reason: SupervisorSignalReason): void => {
    if (proc.pid === undefined) return;
    n.onProcessEvent?.({ type: "signal", signal: sig, reason });
    try {
      if (process.platform !== "win32") {
        process.kill(-proc.pid, sig);
      } else {
        proc.kill(sig);
      }
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // Process may already be gone.
      }
    }
  };

  const startCancelSequence = (reason: "abort" | "cancel"): void => {
    if (state.cancelTimer !== null) return;
    killGroup("SIGTERM", reason);
    state.cancelTimer = armTimer(n.timers, n.cancelGraceMs, () => {
      killGroup("SIGKILL", "grace-expired");
    });
  };
  const onAbort = (): void => {
    state.aborted = true;
    startCancelSequence("abort");
  };

  const exit = new Promise<ExitRecord>((resolve) => {
    const finish = (record: Omit<ExitRecord, "durationMs" | "stderrTail">): void => {
      if (state.settled) return;
      state.settled = true;
      disarmTimer(n.timers, state.watchdogTimer);
      n.signal.removeEventListener("abort", onAbort);
      void waitGroupGone(pgid, n.timers).then(() => {
        disarmTimer(n.timers, state.cancelTimer);
        const full: ExitRecord = {
          ...record,
          stderrTail: state.stderrTail.toString("utf8"),
          durationMs: Math.max(0, n.now() - spawnTs),
        };
        n.onProcessEvent?.({
          type: "exit",
          code: full.code,
          signal: full.signal,
          outcome: full.outcome,
        });
        resolve(full);
      });
    };

    // A real ChildProcess emits "close" after "exit" once its stdio fds are
    // drained; lightweight ChildProcess-shaped doubles emit "exit" only.
    // Resolve on "close", or on "exit" once every piped stdio stream is done.
    let sawExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let sawClose = false;
    const stdioDone = (stream: unknown): boolean => {
      if (stream === null || stream === undefined) return true;
      const s = stream as Readable & { closed?: boolean };
      if (typeof s.readableEnded !== "boolean") return true;
      return s.readableEnded || s.destroyed || s.closed === true;
    };
    const finishFromExit = (): void => {
      if (sawExit === null) return;
      if (!sawClose && !(stdioDone(proc.stdout) && stdioDone(proc.stderr))) return;
      const outcome: ExitOutcome = state.truncated
        ? "output-limit"
        : state.watchdogFired
          ? "watchdog"
          : state.aborted
            ? "cancelled"
            : "exited";
      finish({
        outcome,
        code: sawExit.code,
        signal: sawExit.signal,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    };
    proc.once("exit", (code, exitSignal) => {
      proc.stdin?.destroy();
      sawExit = { code, signal: exitSignal };
      finishFromExit();
    });
    proc.once("error", (err) => {
      state.spawnError = err;
      finish({
        outcome: "spawn-error",
        code: null,
        signal: null,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    });
    proc.once("close", (code, closeSignal) => {
      sawClose = true;
      if (sawExit === null) sawExit = { code, signal: closeSignal };
      finishFromExit();
    });
    const streamDone = (): void => {
      finishFromExit();
    };
    for (const stream of [proc.stdout, proc.stderr]) {
      const emitter = stream as unknown as {
        once?: (event: string, listener: () => void) => void;
      } | null;
      emitter?.once?.("end", streamDone);
      emitter?.once?.("close", streamDone);
    }
  });

  const stdoutNeedsHandler =
    n.stdoutPipe ||
    n.onStdoutChunk !== undefined ||
    n.onLine !== undefined ||
    n.outputLimitBytes !== undefined;
  const stderrNeedsHandler =
    n.stderrPipe ||
    n.onStderrChunk !== undefined ||
    n.onLine !== undefined ||
    n.stderrTailBytes !== undefined ||
    n.outputLimitBytes !== undefined;
  const stdoutLineState: StreamLineState = { pending: "" };
  const stderrLineState: StreamLineState = { pending: "" };
  if (stdoutNeedsHandler && proc.stdout !== null) {
    attachStreamHandler(proc.stdout, state, n, "stdout", stdoutLineState, killGroup);
  }
  if (stderrNeedsHandler && proc.stderr !== null) {
    attachStreamHandler(proc.stderr, state, n, "stderr", stderrLineState, killGroup);
  }

  state.watchdogTimer = armTimer(n.timers, n.watchdogMs, () => {
    state.watchdogFired = true;
    killGroup("SIGKILL", "watchdog");
  });
  // The watchdog is advisory supervision, not a keepalive — never hold the loop open.
  const rawHandle = state.watchdogTimer.handle;
  if (typeof rawHandle === "object" && rawHandle !== null && "unref" in rawHandle) {
    (rawHandle as { unref: () => void }).unref();
  }

  if (n.signal.aborted) {
    onAbort();
  } else {
    n.signal.addEventListener("abort", onAbort, { once: true });
  }

  if (n.stdin !== "pipe" && n.stdin !== "ignore" && proc.stdin !== null) {
    const sink = proc.stdin;
    sink.on("error", () => {
      // A child that died before the write lands is reported via the exit record.
    });
    sink.write(n.stdin, () => {
      sink.end();
    });
  }

  n.onProcessEvent?.({ type: "spawn", pid: proc.pid });

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
      killGroup(sig, "kill");
    },
    cancel: (): void => {
      state.aborted = true;
      startCancelSequence("cancel");
    },
  };
}

export async function runProcess(opts: SuperviseOptions): Promise<RunProcessResult> {
  const proc = superviseProcess({ ...opts, stdin: opts.stdin ?? "ignore" });
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
