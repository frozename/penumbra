/**
 * Infra-host spawn surface (plain JS — must run under `node` with no Bun and
 * no TypeScript): runs child processes through the packed
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

export const CANCEL_GRACE_MS = 500;
/** Default per-dispatch watchdog (host-owned, not a library default). */
export const DISPATCH_DEADLINE_MS = 30_000;

export function buildChildEnv(env) {
  const out = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Buffered spawn: capture stdout+stderr, resolve the exit record. */
export async function spawnFn(argv, env, cwd, opts) {
  const result = await runProcess({
    command: argv[0] ?? "",
    args: argv.slice(1),
    cwd,
    env: buildChildEnv(env),
    signal: opts.signal,
    stdin: "ignore",
    cancelGraceMs: CANCEL_GRACE_MS,
    watchdogMs: opts.deadlineMs ?? DISPATCH_DEADLINE_MS,
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
export async function spawnFnLines(argv, env, cwd, opts) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const proc = superviseProcess({
    command: argv[0] ?? "",
    args: argv.slice(1),
    cwd,
    env: buildChildEnv(env),
    signal: opts.signal,
    stdin: "ignore",
    cancelGraceMs: CANCEL_GRACE_MS,
    watchdogMs: opts.deadlineMs ?? DISPATCH_DEADLINE_MS,
    onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
    onStderrChunk: (chunk) => stderrChunks.push(chunk),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
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
