import type { DispatchEventInput, PermissionProfile } from "@penumbra/core";

import { renderSandboxExecProfile, resolveSandboxDenyRoots } from "@penumbra/core";
import { type ChildProcess, spawn } from "node:child_process";

import type { DispatchEvent } from "../sdk/adapter.js";
import type { ThoughtCapture } from "../worker/thought-capture.js";

import { wrapSandboxExecArgv } from "../worker/sandbox-spawn.js";

export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  /** Names of inherited env vars to drop before spawning (e.g. when an inherited OPENAI_BASE_URL would override the CLI's own auth). */
  unset_env?: string[];
  cwd?: string;
  /**
   * Permission profile the dispatch must run under. When set, the CLI child is
   * spawned via sandbox-exec with a write-deny SBPL profile over the dispatch
   * cwd — the only enforcement surface cli adapters have (they expose no
   * tool-call boundary to gate). Fails closed when sandbox-exec is missing.
   */
  permission_profile?: PermissionProfile | null;
  /**
   * Additional write-deny roots rendered into the SBPL profile alongside the
   * dispatch cwd (caller cwd, project root, worktree fleet base). Ignored when
   * permission_profile is unset.
   */
  sandbox_deny_roots?: readonly string[];
  pass_via?: "stdin" | "argv";
  /** Regex patterns whose matching output lines are removed before returning. Useful for CLIs whose own hook/wrapper code prints chatty noise around the model reply. */
  strip_patterns?: string[];
  /** Optional callback fired when a vendor capacity-error pattern is detected in stderr. */
  onCapacityError?: (err: CapacityError) => void;
  emit_stdout_thoughts?: boolean;
  thoughtCapture?: ThoughtCapture;
  eventContext?: { handoffId: string; workerId?: string; agentName?: string };
  onEvent?: (event: DispatchEventInput) => void;
  log?: { debug?: (fields: Record<string, unknown>, message: string) => void };
}

const CAPACITY_PATTERNS: { provider: string; re: RegExp }[] = [
  { provider: "google", re: /No capacity available for model ([\w.-]+)/ },
];

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

const CLI_SPAWN_OUTPUT_MAX_BYTES = 16_777_216;
const CLI_SPAWN_OUTPUT_CAPACITY_WARNING =
  "cli-spawn output cap exceeded; terminating child and retaining tail output";

interface OutputCapHit {
  stream: "stdout" | "stderr";
  text: string;
}

function makeCappedTextAccumulator(
  maxBytes: number,
  onCapHit?: (text: string) => void,
): { append: (text: string) => boolean; getText: () => string; isCapped: () => boolean } {
  let text = "";
  let bytes = 0;
  let capHit = false;
  const append = (chunk: string): boolean => {
    if (capHit || !chunk) return capHit;
    const chunkBytes = Buffer.byteLength(chunk);
    if (bytes + chunkBytes <= maxBytes) {
      text += chunk;
      bytes += chunkBytes;
      return false;
    }
    const combined = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from(chunk, "utf8")]);
    const tail = combined.subarray(Math.max(0, combined.length - maxBytes));
    text = tail.toString("utf8");
    bytes = tail.length;
    capHit = true;
    onCapHit?.(text);
    return true;
  };
  return {
    append,
    getText: () => text,
    isCapped: () => capHit,
  };
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

const DEFAULT_CANCEL_GRACE_S = 10;
// CLI-adapter watchdog: SIGKILLs the spawned CLI if a single dispatch runs past
// this. 900s (15m) was too tight for substantial work — CLI agents (gemini/agy,
// opencode-cli) doing real lint/implement units were killed mid-task with the
// job unfinished. Bumped to 1800s (30m) to match the orchestrator's default
// per-dispatch timeout_ms budget. Override per-deploy with PENUMBRA_DISPATCH_TIMEOUT_S.
const DEFAULT_DISPATCH_TIMEOUT_S = 1800;

function applyStripPatterns(text: string, patterns: string[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  const compiled = patterns.map((p) => new RegExp(p));
  const lines = text.split("\n");
  const kept = lines.filter((line) => !compiled.some((re) => re.test(line)));
  return kept.join("\n");
}

function readCancelGraceMs(raw?: string): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CANCEL_GRACE_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CANCEL_GRACE_S * 1000;
  return parsed * 1000;
}

function readDispatchTimeoutMs(raw?: string): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  return parsed * 1000;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type SettledProcessExit = { ok: true; exit: ProcessExit } | { ok: false; error: unknown };

function spawnProcess(opts: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdinMode: "ignore" | "pipe";
  sandboxProfile?: string;
}): ChildProcess {
  const argv =
    opts.sandboxProfile !== undefined
      ? wrapSandboxExecArgv([opts.command, ...opts.args], opts.sandboxProfile)
      : [opts.command, ...opts.args];
  return spawn(argv[0] ?? opts.command, argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdinMode, "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
}

function killProcessTree(proc: ChildProcess, kind: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-proc.pid, kind);
    } else {
      proc.kill(kind);
    }
  } catch {
    // Process may already be gone.
  }
}

async function writePrompt(
  stdin: NodeJS.WritableStream | null | undefined,
  prompt: string,
): Promise<void> {
  if (!stdin) return;
  await new Promise<void>((resolve, reject) => {
    stdin.once("error", reject);
    stdin.write(prompt, (err) => {
      if (err) {
        reject(err);
        return;
      }
      stdin.end((endErr?: Error | null) => {
        if (endErr) reject(endErr);
        else resolve();
      });
    });
  });
}

interface ReadStreamTextOpts {
  maxBytes?: number;
  onCapHit?: (text: string) => void;
}

async function readStreamText(
  stream: NodeJS.ReadableStream | null | undefined,
  opts: ReadStreamTextOpts = {},
): Promise<string> {
  if (!stream) return "";
  const cap = makeCappedTextAccumulator(opts.maxBytes ?? CLI_SPAWN_OUTPUT_MAX_BYTES, opts.onCapHit);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of stream) {
    const text = decodeStreamChunk(decoder, chunk);
    cap.append(text);
    if (cap.isCapped()) {
      break;
    }
  }
  if (!cap.isCapped()) {
    cap.append(decoder.decode());
  }
  return cap.getText();
}

function waitForProcessExit(proc: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function settleProcessExit(proc: ChildProcess): Promise<SettledProcessExit> {
  return waitForProcessExit(proc)
    .then((exit) => ({ ok: true, exit }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
}

function emit(
  opts: SpawnOpts,
  kind: DispatchEventInput["kind"],
  meta?: Record<string, unknown>,
): void {
  if (!opts.eventContext || !opts.onEvent) return;
  opts.onEvent({
    handoff_id: opts.eventContext.handoffId,
    worker_id: opts.eventContext.workerId,
    source: "worker",
    kind,
    ts: new Date().toISOString(),
    meta,
  });
}

function captureStdoutThoughts(opts: SpawnOpts, text: string): void {
  if (opts.emit_stdout_thoughts !== true || !opts.thoughtCapture) return;
  const handoffId = opts.eventContext?.handoffId;
  const agentName = opts.eventContext?.agentName;
  if (!handoffId || !agentName) return;

  for (const match of text.matchAll(/<thinking>([\s\S]*?)<\/thinking>/g)) {
    const capturedText = match[1]?.trim();
    if (!capturedText) continue;
    opts.thoughtCapture.recordThought({
      handoffId,
      adapter: "cli-spawn",
      agentName,
      text: capturedText,
    });
  }
}

function buildMergedEnv(opts: SpawnOpts): Record<string, string> {
  const unsetKeys = new Set(opts.unset_env ?? []);
  const merged: Record<string, string> = {};
  const baseEntries: { key: string; value: string | undefined }[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    baseEntries.push({ key: k, value: v });
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    baseEntries.push({ key: k, value: v });
  }
  for (const { key, value } of baseEntries) {
    if (unsetKeys.has(key) || value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

function notifyCapacity(opts: SpawnOpts, stderr: string): void {
  if (!opts.onCapacityError) return;
  const capErr = detectCapacityError(stderr);
  if (!capErr) return;
  try {
    opts.onCapacityError(capErr);
  } catch {
    /* Callback failures must not break the spawn return path. */
  }
}

interface AbortController2 {
  cancelTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
}

interface SpawnContext {
  proc: ChildProcess;
  exitPromise: Promise<SettledProcessExit>;
  spawnTs: number;
  ctrl: AbortController2;
  onAbort: () => void;
}

function startSpawn(opts: SpawnOpts): SpawnContext {
  const isArgv = opts.pass_via === "argv";
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;
  const mergedEnv = buildMergedEnv(opts);

  const cancelGraceMs = readCancelGraceMs(
    opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S,
  );

  // SBPL subpath rules match resolved paths — the effective cwd (dispatch
  // worktree, else the worker cwd) plus every caller-supplied mutable root
  // must be realpath'd before rendering or the deny rules silently miss.
  const sandboxProfile =
    opts.permission_profile !== undefined && opts.permission_profile !== null
      ? renderSandboxExecProfile(
          resolveSandboxDenyRoots(opts.cwd ?? process.cwd(), opts.sandbox_deny_roots),
        )
      : undefined;

  const proc = spawnProcess({
    command: opts.command,
    args: finalArgs,
    env: mergedEnv,
    cwd: opts.cwd,
    stdinMode: isArgv ? "ignore" : "pipe",
    sandboxProfile,
  });
  const spawnTs = Date.now();
  const exitPromise = settleProcessExit(proc);
  emit(opts, "proc.spawn", { argv0: opts.command, pid: proc.pid, has_signal: true });

  const ctrl: AbortController2 = { cancelTimer: null, watchdogTimer: null, timedOut: false };
  const onAbort = (): void => {
    emit(opts, "proc.kill.sent", { pid: proc.pid, signal: "SIGTERM", reason: "abort" });
    killProcessTree(proc, "SIGTERM");
    ctrl.cancelTimer = setTimeout(() => {
      emit(opts, "proc.kill.sent", { pid: proc.pid, signal: "SIGKILL", reason: "grace_expired" });
      killProcessTree(proc, "SIGKILL");
    }, cancelGraceMs);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  return { proc, exitPromise, spawnTs, ctrl, onAbort };
}

function teardownSpawn(opts: SpawnOpts, ctx: SpawnContext): void {
  if (ctx.ctrl.watchdogTimer !== null) clearTimeout(ctx.ctrl.watchdogTimer);
  if (ctx.ctrl.cancelTimer !== null) clearTimeout(ctx.ctrl.cancelTimer);
  opts.signal.removeEventListener("abort", ctx.onAbort);
}

async function awaitExitOrThrow(ctx: SpawnContext): Promise<ProcessExit> {
  const exitResult = await ctx.exitPromise;
  if (!exitResult.ok) throw exitResult.error;
  return exitResult.exit;
}

function checkAborted(opts: SpawnOpts): boolean {
  return opts.signal.aborted;
}

function decodeStreamChunk(decoder: TextDecoder, chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  return decoder.decode(chunk as Uint8Array, { stream: true });
}

async function* streamStdoutDeltas(
  proc: ChildProcess,
  opts: SpawnOpts,
  ctrl: AbortController2,
  onCapHit?: (text: string) => void,
): AsyncGenerator<{ chunk: string }> {
  // Stateful decoder handles multi-byte chars split across chunk boundaries.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const cap = makeCappedTextAccumulator(CLI_SPAWN_OUTPUT_MAX_BYTES, onCapHit);
  for await (const chunk of proc.stdout ?? []) {
    const text = decodeStreamChunk(decoder, chunk);
    if (text) {
      cap.append(text);
      if (cap.isCapped()) return;
      yield { chunk: text };
    }
    if (checkAborted(opts) || ctrl.timedOut) return;
  }
  const tail = decoder.decode();
  if (!cap.isCapped()) {
    cap.append(tail);
    if (tail && !cap.isCapped()) yield { chunk: tail };
  }
}

async function handleStreamLoopError(
  loopErr: unknown,
  ctx: SpawnContext,
  opts: SpawnOpts,
  stderrPromise: Promise<string>,
): Promise<never> {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGKILL");
  }
  const exitResult = await ctx.exitPromise;
  const stderr = await stderrPromise;
  if (!exitResult.ok) {
    opts.log?.debug?.({ loopErr }, "stdout loop error masked by process error");
    throw exitResult.error;
  }
  if (stderr) notifyCapacity(opts, stderr);
  throw loopErr;
}

function emitExitResolved(
  opts: SpawnOpts,
  ctx: SpawnContext,
  exit: ProcessExit,
  reason?: string,
): void {
  emit(opts, "proc.exited.resolved", {
    pid: ctx.proc.pid,
    code: exit.code,
    signal: exit.signal,
    wall_ms_since_spawn: Date.now() - ctx.spawnTs,
    ...(reason ? { reason } : {}),
  });
}

async function handleWatchdogExit(
  ctx: SpawnContext,
  opts: SpawnOpts,
  dispatchTimeoutMs: number,
): Promise<never> {
  await awaitExitOrThrow(ctx);
  emit(opts, "proc.exited.resolved", {
    pid: ctx.proc.pid,
    code: null,
    signal: "SIGKILL",
    wall_ms_since_spawn: Date.now() - ctx.spawnTs,
    reason: "watchdog",
  });
  throw new Error(
    `${opts.command}: dispatch exceeded ${dispatchTimeoutMs.toString()}ms (watchdog)`,
  );
}

function outputCapWarning(cap: OutputCapHit, command: string): string {
  return `${command}: output cap exceeded on ${cap.stream}; retained ${String(cap.text.length)} byte tail`;
}

async function* finalizeStreamExit(
  ctx: SpawnContext,
  opts: SpawnOpts,
  stderrPromise: Promise<string>,
  collected: string,
  outputCap?: OutputCapHit,
): AsyncGenerator<DispatchEvent> {
  const cap = outputCap?.text ? outputCap : undefined;
  const [stderr, exit] = await Promise.all([stderrPromise, awaitExitOrThrow(ctx)]);
  emitExitResolved(opts, ctx, exit, cap ? "output_capacity" : undefined);
  notifyCapacity(opts, stderr);

  const finalText = applyStripPatterns(collected, opts.strip_patterns);
  validateExitSuccess(opts, exit, stderr, finalText, cap);
  yield { type: "done", result: { text: finalText } };
  if (cap) {
    throw new Error(outputCapWarning(cap, opts.command));
  }
  ensureExitCodeOk(opts, exit, stderr);
}

function validateExitSuccess(
  opts: SpawnOpts,
  exit: ProcessExit,
  stderr: string,
  finalText: string,
  outputCap?: OutputCapHit | null,
): void {
  if (exit.signal && !outputCap) {
    throw new Error(`${opts.command}: signal ${exit.signal}${stderr ? ` — ${stderr}` : ""}`);
  }
  if (exit.code === 0 && !finalText.trim() && stderr.trim()) {
    throw new Error(`${opts.command}: empty output — ${stderr.trim().slice(0, 500)}`);
  }
}

function ensureExitCodeOk(opts: SpawnOpts, exit: ProcessExit, stderr: string): void {
  if (exit.code === 0) return;
  const codeText = exit.code === null ? "null" : exit.code.toString();
  throw new Error(`${opts.command}: exit code ${codeText}${stderr ? ` — ${stderr}` : ""}`);
}

async function* runStreamStdout(
  ctx: SpawnContext,
  opts: SpawnOpts,
  stderrPromise: Promise<string>,
  outputCap?: OutputCapHit,
  onOutputCap?: (stream: "stdout" | "stderr", text: string) => void,
): AsyncGenerator<{ delta: string }> {
  try {
    for await (const delta of streamStdoutDeltas(ctx.proc, opts, ctx.ctrl, (text) => {
      if (!onOutputCap) return;
      onOutputCap("stdout", text);
    })) {
      yield { delta: delta.chunk };
    }
  } catch (loopErr) {
    await handleStreamLoopError(loopErr, ctx, opts, stderrPromise);
  }
}

export async function* spawnCliAdapterStream(opts: SpawnOpts): AsyncGenerator<DispatchEvent> {
  if (opts.signal.aborted) {
    throw new Error(`${opts.command}: signal aborted before spawn`);
  }
  const dispatchTimeoutMs = readDispatchTimeoutMs(
    opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S,
  );

  const ctx = startSpawn(opts);
  const { proc, ctrl } = ctx;
  const outputCap: OutputCapHit = {
    stream: "stdout",
    text: "",
  };

  const onOutputCap = (stream: "stdout" | "stderr", text: string): void => {
    if (outputCap.text) return;
    outputCap.stream = stream;
    outputCap.text = text;
    emit(opts, "proc.kill.sent", {
      pid: proc.pid,
      signal: "SIGKILL",
      reason: "output_capacity",
      stream,
    });
    opts.log?.debug?.(
      {
        command: opts.command,
        stream,
        max_bytes: CLI_SPAWN_OUTPUT_MAX_BYTES,
      },
      CLI_SPAWN_OUTPUT_CAPACITY_WARNING,
    );
    killProcessTree(proc, "SIGKILL");
  };

  if (opts.pass_via !== "argv") {
    await writePrompt(proc.stdin, opts.prompt);
  }

  ctrl.watchdogTimer = setTimeout(() => {
    ctrl.timedOut = true;
    killProcessTree(proc, "SIGKILL");
  }, dispatchTimeoutMs);

  // Start collecting stderr in parallel so it doesn't block stdout consumption.
  const stderrPromise = readStreamText(proc.stderr, {
    onCapHit: (text) => {
      onOutputCap("stderr", text);
    },
  });
  stderrPromise.catch(() => {
    /* stderr drain errors are surfaced via the exit handling path */
  });

  let collected = "";

  try {
    for await (const out of runStreamStdout(ctx, opts, stderrPromise, outputCap, onOutputCap)) {
      collected += out.delta;
      yield { type: "delta", text: out.delta };
    }

    if (ctrl.timedOut) {
      await handleWatchdogExit(ctx, opts, dispatchTimeoutMs);
    }

    if (checkAborted(opts)) {
      const exit = await awaitExitOrThrow(ctx);
      emitExitResolved(opts, ctx, exit);
      yield { type: "done", result: { text: applyStripPatterns(collected, opts.strip_patterns) } };
      return;
    }

    yield* finalizeStreamExit(ctx, opts, stderrPromise, collected, outputCap);
  } finally {
    teardownSpawn(opts, ctx);
  }
}

interface NonStreamResult {
  rawText: string;
  stderr: string;
  exit: ProcessExit;
  outputCap?: OutputCapHit;
}

async function readChildOutputs(
  ctx: SpawnContext,
  opts: SpawnOpts,
  onOutputCap?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<NonStreamResult> {
  const outputCap: OutputCapHit = {
    stream: "stdout",
    text: "",
  };
  const [rawText, stderr, exit] = await Promise.all([
    readStreamText(ctx.proc.stdout, {
      onCapHit: (text) => {
        if (outputCap.text) return;
        outputCap.stream = "stdout";
        outputCap.text = text;
        onOutputCap?.("stdout", text);
      },
    }),
    readStreamText(ctx.proc.stderr, {
      onCapHit: (text) => {
        if (outputCap.text) return;
        outputCap.stream = "stderr";
        outputCap.text = text;
        onOutputCap?.("stderr", text);
      },
    }),
    awaitExitOrThrow(ctx),
  ]);
  emitExitResolved(opts, ctx, exit, outputCap.text ? "output_capacity" : undefined);
  notifyCapacity(opts, stderr);
  return {
    rawText,
    stderr,
    exit,
    ...(outputCap.text ? { outputCap } : {}),
  };
}

function buildSpawnError(opts: SpawnOpts, exit: ProcessExit, stderr: string): Error {
  if (exit.signal) {
    return new Error(`${opts.command}: signal ${exit.signal}${stderr ? ` — ${stderr}` : ""}`);
  }
  const codeText = exit.code === null ? "null" : exit.code.toString();
  return new Error(`${opts.command}: exit code ${codeText}${stderr ? ` — ${stderr}` : ""}`);
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  if (opts.signal.aborted) {
    throw new Error(`${opts.command}: signal aborted before spawn`);
  }
  const dispatchTimeoutMs = readDispatchTimeoutMs(
    opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S,
  );
  const ctx = startSpawn(opts);
  const { proc, ctrl } = ctx;
  const outputCap: OutputCapHit = {
    stream: "stdout",
    text: "",
  };
  const onOutputCap = (stream: "stdout" | "stderr", text: string): void => {
    if (outputCap.text) return;
    outputCap.stream = stream;
    outputCap.text = text;
    emit(opts, "proc.kill.sent", {
      pid: proc.pid,
      signal: "SIGKILL",
      reason: "output_capacity",
      stream,
    });
    opts.log?.debug?.(
      {
        command: opts.command,
        stream,
        max_bytes: CLI_SPAWN_OUTPUT_MAX_BYTES,
      },
      CLI_SPAWN_OUTPUT_CAPACITY_WARNING,
    );
    killProcessTree(proc, "SIGKILL");
  };

  if (opts.pass_via !== "argv") {
    await writePrompt(proc.stdin, opts.prompt);
  }

  // Watchdog: bound the total dispatch in case the child writes nothing
  // and proc.exited never resolves (observed under Bun 1.3.13 when a child
  // tree dies in some races). On timeout, SIGKILL the proc and reject so
  // the worker frees up instead of waiting forever.
  const watchdog = new Promise<never>((_, reject) => {
    ctrl.watchdogTimer = setTimeout(() => {
      ctrl.timedOut = true;
      killProcessTree(proc, "SIGKILL");
      emit(opts, "proc.exited.resolved", {
        pid: proc.pid,
        code: null,
        signal: "SIGKILL",
        wall_ms_since_spawn: Date.now() - ctx.spawnTs,
        reason: "watchdog",
      });
      reject(
        new Error(
          `${opts.command}: dispatch exceeded ${dispatchTimeoutMs.toString()}ms (watchdog)`,
        ),
      );
    }, dispatchTimeoutMs);
  });

  try {
    const result = await Promise.race([readChildOutputs(ctx, opts, onOutputCap), watchdog]);
    if (checkAborted(opts)) {
      throw new Error(`${opts.command}: aborted`);
    }
    captureStdoutThoughts(opts, result.rawText);
    if (result.outputCap) {
      throw new Error(outputCapWarning(result.outputCap, opts.command));
    }
    if (result.exit.signal || result.exit.code !== 0) {
      throw buildSpawnError(opts, result.exit, result.stderr);
    }
    return {
      text: applyStripPatterns(result.rawText, opts.strip_patterns),
      stderr: result.stderr,
    };
  } finally {
    teardownSpawn(opts, ctx);
  }
}
