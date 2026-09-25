/**
 * Infra-host spawn surface: runs child processes through the packed
 * runProcess/superviseProcess with an explicit env allowlist. The package
 * receives only host-owned inputs — the ambient environment is filtered here,
 * in the consumer, never merged inside the library.
 */
import { type ExitOutcome, runProcess, superviseProcess } from "penumbra-exec-primitives";

/** Host-owned env allowlist: only these names may cross into child envs. */
export const ALLOWED_ENV_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "FAKE_ACP_LOG",
  "FAKE_ACP_REQUIRE_AUTH",
  "FAKE_ACP_ECHO_ENV",
  "FAKE_ACP_ASK_PERMISSION",
  "FAKE_ACP_DELAY_MS",
  "INFRA_MARKER",
] as const;

/** The infra host's dispatch binding: binding-level caps the caller can only tighten. */
export interface SpawnBinding {
  /** Binding-level dispatch timeout; the effective watchdog is min(this, ctx.deadline). */
  timeoutMs: number;
  /** Host-owned cancel grace for SIGTERM→SIGKILL escalation. */
  cancelGraceMs: number;
  /** Optional per-stream output cap forwarded to the supervisor. */
  outputLimitBytes?: number;
}

export const SPAWN_BINDING: SpawnBinding = {
  timeoutMs: 30_000,
  cancelGraceMs: 500,
};

export interface SpawnCtx {
  signal: AbortSignal;
  /** Per-dispatch wall-clock deadline in ms — required, never defaulted. */
  deadline: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outcome: ExitOutcome;
}

export type HostEnv = Record<string, string | undefined>;

export function buildChildEnv(env: HostEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Buffered spawn: capture stdout+stderr, resolve the exit record. */
export async function spawnFn(
  argv: string[],
  env: HostEnv,
  cwd: string,
  ctx: SpawnCtx,
  binding: SpawnBinding = SPAWN_BINDING,
): Promise<SpawnResult> {
  const result = await runProcess({
    command: argv[0] ?? "",
    args: argv.slice(1),
    cwd,
    env: buildChildEnv(env),
    signal: ctx.signal,
    stdin: "ignore",
    cancelGraceMs: binding.cancelGraceMs,
    watchdogMs: Math.min(binding.timeoutMs, ctx.deadline),
    ...(binding.outputLimitBytes !== undefined
      ? { outputLimitBytes: binding.outputLimitBytes }
      : {}),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exit.code,
    signal: result.exit.signal,
    outcome: result.exit.outcome,
  };
}

/** Line-streaming spawn: forward complete output lines as they arrive. */
export async function spawnFnLines(
  argv: string[],
  env: HostEnv,
  cwd: string,
  ctx: SpawnCtx,
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
  binding: SpawnBinding = SPAWN_BINDING,
): Promise<SpawnResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const proc = superviseProcess({
    command: argv[0] ?? "",
    args: argv.slice(1),
    cwd,
    env: buildChildEnv(env),
    signal: ctx.signal,
    stdin: "ignore",
    cancelGraceMs: binding.cancelGraceMs,
    watchdogMs: Math.min(binding.timeoutMs, ctx.deadline),
    onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
    onStderrChunk: (chunk) => stderrChunks.push(chunk),
    ...(onLine !== undefined ? { onLine } : {}),
  });
  const exit = await proc.exit;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode: exit.code,
    signal: exit.signal,
    outcome: exit.outcome,
  };
}
