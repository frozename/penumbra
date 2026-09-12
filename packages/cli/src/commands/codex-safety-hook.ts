import { resolveStorageDbPath } from "@penumbra/core";
import { isAbsolute } from "node:path";

import { normalizeCodexHook } from "./codex-hook-contract.js";

const MAX_RAW_EVENT_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_GUARD_OUTPUT_BYTES = 64 * 1024;
const GUARD_TIMEOUT_MS = 10_000;
const NOT_INSPECTED =
  "penumbra codex-safety: command was not inspected; input is not a supported Codex PreToolUse Bash.command or exec_command.cmd event";

export interface CodexGuardSemanticInput {
  event: "PreToolUse";
  command: string;
  cwd: string;
}

export interface RunCodexSafetyHookOptions {
  rawEvent: string;
  guardPath: string;
  sentinelPath: string;
  storageRoot?: string;
}

interface GuardInput {
  tool_input: { command: string };
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCommand(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (Buffer.byteLength(value) > MAX_COMMAND_BYTES) return null;
  return value;
}

function semanticInput(rawEvent: string): CodexGuardSemanticInput | null {
  if (Buffer.byteLength(rawEvent) > MAX_RAW_EVENT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(rawEvent);
  } catch {
    return null;
  }
  const normalized = normalizeCodexHook(raw, {
    role: "unknown",
    rootSessionId: null,
    provenance: "unknown",
  });
  if (normalized?.event !== "PreToolUse" || !isRecord(normalized.rawToolInput)) {
    return null;
  }
  const command =
    normalized.rawToolName === "Bash"
      ? boundedCommand(normalized.rawToolInput.command)
      : normalized.rawToolName === "exec_command"
        ? boundedCommand(normalized.rawToolInput.cmd)
        : null;
  return command === null ? null : { event: "PreToolUse", command, cwd: normalized.cwd };
}

export function normalizeCodexGuardInput(input: CodexGuardSemanticInput): GuardInput {
  return { tool_input: { command: input.command }, cwd: input.cwd };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation ??= reader.cancel().catch(() => {
      // Cancellation may race with the stream closing naturally.
    });
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("guard output exceeded the bounded limit");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
}

function emit(output: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function diagnose(message: string): void {
  process.stderr.write(`${message}\n`);
}

function uninspected(message = NOT_INSPECTED): number {
  diagnose(message);
  emit({ systemMessage: message });
  return 0;
}

function invalidConfiguration(message: string): number {
  diagnose(message);
  emit({ systemMessage: message });
  return 1;
}

function boundedDiagnostic(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, MAX_GUARD_OUTPUT_BYTES);
}

function denialDiagnostic(stderr: string, stdout: string): string {
  return stderr.trim().length > 0 ? stderr : stdout;
}

function guardEnvironment(opts: RunCodexSafetyHookOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENUMBRA_ALLOW_AGENT_GC_SENTINEL: opts.sentinelPath,
  };
  if (env.PENUMBRA_DB === undefined && opts.storageRoot !== undefined) {
    env.PENUMBRA_DB = resolveStorageDbPath(opts.storageRoot);
  }
  return env;
}

function killOwnedProcessTree(child: { pid: number; kill(signal: NodeJS.Signals): void }): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The owned process group may already be gone.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Signal delivery may race with the child exiting naturally.
  }
}

export async function runCodexSafetyHook(opts: RunCodexSafetyHookOptions): Promise<number> {
  if (!isAbsolute(opts.guardPath) || !isAbsolute(opts.sentinelPath)) {
    return invalidConfiguration(
      "penumbra codex-safety: guard and sentinel paths must be absolute managed paths",
    );
  }
  const semantic = semanticInput(opts.rawEvent);
  if (!semantic) return uninspected();

  const state = { timedOut: false };
  try {
    const child = Bun.spawn(["bash", opts.guardPath], {
      env: guardEnvironment(opts),
      detached: process.platform !== "win32",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const outputAbort = new AbortController();
    const abort = (): void => {
      killOwnedProcessTree(child);
      outputAbort.abort();
    };
    const exited = child.exited;
    const stdout = readBounded(child.stdout, MAX_GUARD_OUTPUT_BYTES, outputAbort.signal);
    const stderr = readBounded(child.stderr, MAX_GUARD_OUTPUT_BYTES, outputAbort.signal);
    const timer = setTimeout(() => {
      state.timedOut = true;
      abort();
    }, GUARD_TIMEOUT_MS);
    try {
      await child.stdin.write(JSON.stringify(normalizeCodexGuardInput(semantic)));
      await child.stdin.end();
      const [exitCode, stdoutText, stderrText] = await Promise.all([exited, stdout, stderr]);
      if (state.timedOut) {
        return invalidConfiguration("penumbra codex-safety: managed guard timed out");
      }
      if (stderrText.trim().length > 0) diagnose(boundedDiagnostic(stderrText, ""));
      if (exitCode === 0) {
        emit({});
        return 0;
      }
      if (exitCode === 2) {
        const reason = boundedDiagnostic(
          denialDiagnostic(stderrText, stdoutText),
          "Penumbra safety guard denied this command.",
        );
        emit({ decision: "block", reason });
        return 2;
      }
      emit({
        systemMessage: `penumbra codex-safety: managed guard failed with exit ${String(exitCode)}`,
      });
      return 1;
    } catch (error) {
      abort();
      await Promise.allSettled([exited, stdout, stderr]);
      if (state.timedOut) {
        return invalidConfiguration("penumbra codex-safety: managed guard timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalidConfiguration(`penumbra codex-safety: managed guard failed: ${detail}`);
  }
}
