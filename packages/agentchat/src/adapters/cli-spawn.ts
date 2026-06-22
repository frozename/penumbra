import type { DispatchEventInput } from "@penumbra/core";

import { type ChildProcess, spawn } from "node:child_process";

import type { DispatchEvent } from "../sdk/adapter.js";
import type { ThoughtCapture } from "../worker/thought-capture.js";

export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  /** Names of inherited env vars to drop before spawning (e.g. when an inherited OPENAI_BASE_URL would override the CLI's own auth). */
  unset_env?: string[];
  cwd?: string;
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
const DEFAULT_DISPATCH_TIMEOUT_S = 900;

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
}): ChildProcess {
  return spawn(opts.command, opts.args, {
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

async function readStreamText(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!stream) return "";
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
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

  const proc = spawnProcess({
    command: opts.command,
    args: finalArgs,
    env: mergedEnv,
    cwd: opts.cwd,
    stdinMode: isArgv ? "ignore" : "pipe",
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
): AsyncGenerator<{ chunk: string }> {
  // Stateful decoder handles multi-byte chars split across chunk boundaries.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of proc.stdout ?? []) {
    const text = decodeStreamChunk(decoder, chunk);
    if (text) yield { chunk: text };
    if (checkAborted(opts) || ctrl.timedOut) return;
  }
  const tail = decoder.decode();
  if (tail) yield { chunk: tail };
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

async function* finalizeStreamExit(
  ctx: SpawnContext,
  opts: SpawnOpts,
  stderrPromise: Promise<string>,
  collected: string,
): AsyncGenerator<DispatchEvent> {
  const [stderr, exit] = await Promise.all([stderrPromise, awaitExitOrThrow(ctx)]);
  emitExitResolved(opts, ctx, exit);
  notifyCapacity(opts, stderr);

  const finalText = applyStripPatterns(collected, opts.strip_patterns);
  validateExitSuccess(opts, exit, stderr, finalText);
  yield { type: "done", result: { text: finalText } };
  ensureExitCodeOk(opts, exit, stderr);
}

function validateExitSuccess(
  opts: SpawnOpts,
  exit: ProcessExit,
  stderr: string,
  finalText: string,
): void {
  if (exit.signal) {
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
): AsyncGenerator<{ delta: string }> {
  try {
    for await (const delta of streamStdoutDeltas(ctx.proc, opts, ctx.ctrl)) {
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

  if (opts.pass_via !== "argv") {
    await writePrompt(proc.stdin, opts.prompt);
  }

  ctrl.watchdogTimer = setTimeout(() => {
    ctrl.timedOut = true;
    killProcessTree(proc, "SIGKILL");
  }, dispatchTimeoutMs);

  // Start collecting stderr in parallel so it doesn't block stdout consumption.
  const stderrPromise = readStreamText(proc.stderr);
  stderrPromise.catch(() => {
    /* stderr drain errors are surfaced via the exit handling path */
  });

  let collected = "";

  try {
    for await (const out of runStreamStdout(ctx, opts, stderrPromise)) {
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

    yield* finalizeStreamExit(ctx, opts, stderrPromise, collected);
  } finally {
    teardownSpawn(opts, ctx);
  }
}

interface NonStreamResult {
  rawText: string;
  stderr: string;
  exit: ProcessExit;
}

async function readChildOutputs(ctx: SpawnContext, opts: SpawnOpts): Promise<NonStreamResult> {
  const [rawText, stderr, exit] = await Promise.all([
    readStreamText(ctx.proc.stdout),
    readStreamText(ctx.proc.stderr),
    awaitExitOrThrow(ctx),
  ]);
  emitExitResolved(opts, ctx, exit);
  notifyCapacity(opts, stderr);
  return { rawText, stderr, exit };
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
    const result = await Promise.race([readChildOutputs(ctx, opts), watchdog]);
    if (checkAborted(opts)) {
      throw new Error(`${opts.command}: aborted`);
    }
    captureStdoutThoughts(opts, result.rawText);
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
