/**
 * Parity shim: re-creates the legacy `adapters/cli-spawn.ts` surface
 * (spawnCliAdapter / spawnCliAdapterStream) over the extracted
 * `penumbra-exec-primitives` process supervisor. Host-owned concerns that the
 * package deliberately does not provide — ambient env merging, PENUMBRA_*
 * timeout env vars, dispatch lifecycle events, thought capture — live here, in
 * the consumer, where they belong.
 */
import {
  detectCapacityError,
  superviseProcess,
  type CapacityError,
  type ExitRecord,
  type SupervisedProcess,
  type SupervisorEvent,
} from "penumbra-exec-primitives";

import type { DispatchEvent, DispatchEventInput, ThoughtCapture } from "./types.js";

export { detectCapacityError };
export type { CapacityError };

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

const DEFAULT_CANCEL_GRACE_S = 10;
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

function decodeStreamChunk(decoder: TextDecoder, chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  return decoder.decode(chunk as Uint8Array, { stream: true });
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

function outputCapWarning(cap: OutputCapHit, command: string): string {
  return `${command}: output cap exceeded on ${cap.stream}; retained ${String(cap.text.length)} byte tail`;
}

interface SpawnContext {
  proc: SupervisedProcess;
  spawnTs: number;
  dispatchTimeoutMs: number;
  outputCap: OutputCapHit;
  stdoutCap: ReturnType<typeof makeCappedTextAccumulator>;
  stderrCap: ReturnType<typeof makeCappedTextAccumulator>;
  stdoutDecoder?: TextDecoder;
  stderrDecoder?: TextDecoder;
  shimKilled: boolean;
}

function startSpawn(opts: SpawnOpts, streaming: boolean): SpawnContext {
  const isArgv = opts.pass_via === "argv";
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;
  const mergedEnv = buildMergedEnv(opts);
  const cancelGraceMs = readCancelGraceMs(
    opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S,
  );
  const dispatchTimeoutMs = readDispatchTimeoutMs(
    opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S,
  );

  const ctx: SpawnContext = {
    proc: undefined as unknown as SupervisedProcess,
    spawnTs: Date.now(),
    dispatchTimeoutMs,
    outputCap: { stream: "stdout", text: "" },
    stdoutCap: makeCappedTextAccumulator(CLI_SPAWN_OUTPUT_MAX_BYTES),
    stderrCap: makeCappedTextAccumulator(CLI_SPAWN_OUTPUT_MAX_BYTES),
    shimKilled: false,
  };

  const onProcessEvent = (event: SupervisorEvent): void => {
    if (event.type === "spawn") {
      emit(opts, "proc.spawn", { argv0: opts.command, pid: event.pid, has_signal: true });
      return;
    }
    if (event.type === "signal") {
      // The package reports every signal it sends; the legacy surface only
      // emitted kill events for the abort/grace escalation path. Watchdog and
      // shim-initiated kills are reported through proc.exited.resolved /
      // proc.kill.sent by this shim instead.
      if (event.reason === "abort") {
        emit(opts, "proc.kill.sent", {
          pid: ctx.proc.pid,
          signal: event.signal,
          reason: "abort",
        });
      } else if (event.reason === "grace-expired") {
        emit(opts, "proc.kill.sent", {
          pid: ctx.proc.pid,
          signal: event.signal,
          reason: "grace_expired",
        });
      }
      return;
    }
    if (event.type === "exit") {
      emit(opts, "proc.exited.resolved", {
        pid: ctx.proc.pid,
        code: event.code,
        signal: event.signal,
        wall_ms_since_spawn: Date.now() - ctx.spawnTs,
        ...(event.outcome === "watchdog"
          ? { reason: "watchdog" }
          : ctx.outputCap.text
            ? { reason: "output_capacity" }
            : {}),
      });
    }
  };

  ctx.proc = superviseProcess({
    command: opts.command,
    args: finalArgs,
    cwd: opts.cwd ?? process.cwd(),
    env: mergedEnv,
    signal: opts.signal,
    cancelGraceMs,
    watchdogMs: dispatchTimeoutMs,
    stdin: isArgv ? "ignore" : opts.prompt,
    stdoutMode: streaming ? "raw" : "pipe",
    stderrMode: streaming ? "raw" : "pipe",
    onStdoutChunk: streaming ? undefined : (chunk) => appendStreamChunk(ctx, "stdout", chunk, opts),
    onStderrChunk: streaming ? undefined : (chunk) => appendStreamChunk(ctx, "stderr", chunk, opts),
    onProcessEvent,
  });
  return ctx;
}

function appendStreamChunk(
  ctx: SpawnContext,
  stream: "stdout" | "stderr",
  chunk: Buffer,
  opts: SpawnOpts,
): void {
  const decoder =
    stream === "stdout"
      ? (ctx.stdoutDecoder ??= new TextDecoder("utf-8", { fatal: false }))
      : (ctx.stderrDecoder ??= new TextDecoder("utf-8", { fatal: false }));
  const text = decodeStreamChunk(decoder, chunk);
  const cap = stream === "stdout" ? ctx.stdoutCap : ctx.stderrCap;
  cap.append(text);
  if (cap.isCapped()) onShimOutputCap(ctx, stream, cap.getText(), opts);
}

function onShimOutputCap(
  ctx: SpawnContext,
  stream: "stdout" | "stderr",
  text: string,
  opts: SpawnOpts,
): void {
  if (ctx.outputCap.text) return;
  ctx.outputCap.stream = stream;
  ctx.outputCap.text = text;
  ctx.shimKilled = true;
  emit(opts, "proc.kill.sent", {
    pid: ctx.proc.pid,
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
  ctx.proc.kill("SIGKILL");
}

async function shimReadStreamText(
  stream: NodeJS.ReadableStream | AsyncIterable<Buffer> | undefined,
  onCapHit?: (text: string) => void,
): Promise<string> {
  if (!stream) return "";
  const cap = makeCappedTextAccumulator(CLI_SPAWN_OUTPUT_MAX_BYTES, onCapHit);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of stream) {
    cap.append(decodeStreamChunk(decoder, chunk));
    if (cap.isCapped()) break;
  }
  if (!cap.isCapped()) cap.append(decoder.decode());
  return cap.getText();
}

function flushDecoderText(ctx: SpawnContext): { stdout: string; stderr: string } {
  ctx.stdoutCap.append(ctx.stdoutDecoder?.decode() ?? "");
  ctx.stderrCap.append(ctx.stderrDecoder?.decode() ?? "");
  return { stdout: ctx.stdoutCap.getText(), stderr: ctx.stderrCap.getText() };
}

function buildSpawnError(opts: SpawnOpts, exit: ExitRecord, stderr: string): Error {
  if (exit.signal) {
    return new Error(`${opts.command}: signal ${exit.signal}${stderr ? ` — ${stderr}` : ""}`);
  }
  const codeText = exit.code === null ? "null" : exit.code.toString();
  return new Error(`${opts.command}: exit code ${codeText}${stderr ? ` — ${stderr}` : ""}`);
}

function isAborted(opts: SpawnOpts, exit: ExitRecord): boolean {
  return opts.signal.aborted || exit.outcome === "cancelled";
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  if (opts.signal.aborted) {
    throw new Error(`${opts.command}: signal aborted before spawn`);
  }
  const ctx = startSpawn(opts, false);
  const exit = await ctx.proc.exit;
  const { stdout: rawText, stderr } = flushDecoderText(ctx);
  notifyCapacity(opts, stderr);

  if (exit.outcome === "watchdog") {
    throw new Error(
      `${opts.command}: dispatch exceeded ${ctx.dispatchTimeoutMs.toString()}ms (watchdog)`,
    );
  }
  if (isAborted(opts, exit)) {
    throw new Error(`${opts.command}: aborted`);
  }
  captureStdoutThoughts(opts, rawText);
  if (ctx.outputCap.text) {
    throw new Error(outputCapWarning(ctx.outputCap, opts.command));
  }
  if (exit.signal || exit.code !== 0) {
    throw buildSpawnError(opts, exit, stderr);
  }
  return {
    text: applyStripPatterns(rawText, opts.strip_patterns),
    stderr,
  };
}

export async function* spawnCliAdapterStream(opts: SpawnOpts): AsyncGenerator<DispatchEvent> {
  if (opts.signal.aborted) {
    throw new Error(`${opts.command}: signal aborted before spawn`);
  }
  const ctx = startSpawn(opts, true);
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const stderrPromise = shimReadStreamText(ctx.proc.stderr, (text) => {
    onShimOutputCap(ctx, "stderr", text, opts);
  });
  stderrPromise.catch(() => {
    /* stderr drain errors are surfaced via the exit handling path */
  });

  let collected = "";
  let capped = false;
  try {
    for await (const chunk of ctx.proc.stdout ?? []) {
      const text = decodeStreamChunk(decoder, chunk);
      if (!text) continue;
      ctx.stdoutCap.append(text);
      if (ctx.stdoutCap.isCapped()) {
        onShimOutputCap(ctx, "stdout", ctx.stdoutCap.getText(), opts);
        capped = true;
        break;
      }
      collected += text;
      yield { type: "delta", text };
      if (opts.signal.aborted) break;
    }
    if (!capped) ctx.stdoutCap.append(decoder.decode());
  } catch (loopErr) {
    ctx.proc.kill("SIGKILL");
    const exit = await ctx.proc.exit;
    await stderrPromise;
    if (exit.outcome === "spawn-error" && ctx.proc.spawnError) throw ctx.proc.spawnError;
    notifyCapacity(opts, ctx.stderrCap.getText());
    throw loopErr;
  }

  const [stderr, exit] = await Promise.all([stderrPromise, ctx.proc.exit]);
  collected = ctx.stdoutCap.isCapped() ? ctx.stdoutCap.getText() : collected + decoder.decode();
  notifyCapacity(opts, stderr);

  if (exit.outcome === "watchdog") {
    throw new Error(
      `${opts.command}: dispatch exceeded ${ctx.dispatchTimeoutMs.toString()}ms (watchdog)`,
    );
  }

  const cap = ctx.outputCap.text ? ctx.outputCap : undefined;
  const finalText = applyStripPatterns(collected, opts.strip_patterns);

  if (isAborted(opts, exit)) {
    yield { type: "done", result: { text: finalText } };
    return;
  }
  if (exit.signal && !cap) {
    throw new Error(`${opts.command}: signal ${exit.signal}${stderr ? ` — ${stderr}` : ""}`);
  }
  if (exit.code === 0 && !finalText.trim() && stderr.trim()) {
    throw new Error(`${opts.command}: empty output — ${stderr.trim().slice(0, 500)}`);
  }
  yield { type: "done", result: { text: finalText } };
  if (cap) {
    throw new Error(outputCapWarning(cap, opts.command));
  }
  if (exit.code !== 0) {
    const codeText = exit.code === null ? "null" : exit.code.toString();
    throw new Error(`${opts.command}: exit code ${codeText}${stderr ? ` — ${stderr}` : ""}`);
  }
}
