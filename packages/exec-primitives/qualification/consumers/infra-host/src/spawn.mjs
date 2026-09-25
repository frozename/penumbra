/**
 * Infra-host spawn surface (plain JS): runs child processes through the packed
 * runProcess/superviseProcess with an explicit env allowlist. The package
 * receives only host-owned inputs — the ambient environment is filtered here,
 * in the consumer, never merged inside the library.
 */
import { runProcess, superviseProcess } from "penumbra-exec-primitives";

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
];

/** The infra host's dispatch binding: binding-level caps the caller can only tighten. */
export const SPAWN_BINDING = {
  timeoutMs: 30_000,
  cancelGraceMs: 500,
};

export function buildChildEnv(env) {
  const out = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Buffered spawn: capture stdout+stderr, resolve the exit record. */
export async function spawnFn(argv, env, cwd, ctx, binding = SPAWN_BINDING) {
  const result = await runProcess({
    command: argv[0] ?? "",
    args: argv.slice(1),
    cwd,
    env: buildChildEnv(env),
    signal: ctx.signal,
    stdin: "ignore",
    cancelGraceMs: binding.cancelGraceMs,
    watchdogMs: Math.min(binding.timeoutMs, ctx.deadline),
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
export async function spawnFnLines(argv, env, cwd, ctx, onLine, binding = SPAWN_BINDING) {
  const stdoutChunks = [];
  const stderrChunks = [];
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
