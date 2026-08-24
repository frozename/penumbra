import { fileURLToPath } from "node:url";

export type WorkerCrashFault = "unhandledRejection" | "uncaughtException";

export interface WorkerCrashGuardSubprocessResult {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stillAliveAfterGrace: boolean;
}

const FATAL_MARKER_PATTERN = /worker_fatal|worker[._]unhandled_rejection/;

// installGlobalCrashHandlers logs the fatal record and (when it decides to exit) calls
// process.exit() synchronously in the same handler call -- there is no async gap between
// "fatal line written" and "exit requested". So waiting for the marker to actually appear
// in stderr, instead of guessing a fixed sleep, decouples this from subprocess cold-boot
// time (highly variable under fleet load) without weakening what's being proven. This
// timeout is a safety net against a genuine hang, not the pass/fail signal.
const FATAL_MARKER_TIMEOUT_MS = 4_000;

export async function spawnWorkerCrashGuardSubprocess(opts: {
  fault: WorkerCrashFault;
  env?: Record<string, string>;
  graceMs?: number;
}): Promise<WorkerCrashGuardSubprocessResult> {
  const cwd = fileURLToPath(new URL("../../../..", import.meta.url));
  const graceMs = opts.graceMs ?? 1_000;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.PENUMBRA_WORKER_CRASH_GUARD;
  Object.assign(env, opts.env);

  const script = `
    import { installGlobalCrashHandlers } from "./packages/agentchat/src/worker/crash-guard.ts";

    installGlobalCrashHandlers({
      log: {
        error(record, message) {
          process.stderr.write(JSON.stringify({ record, message }) + "\\n");
        },
      },
      flush() {
        process.stderr.write("flush_called\\n");
      },
    });

    if (${JSON.stringify(opts.fault)} === "uncaughtException") {
      setTimeout(() => {
        throw new Error("boom");
      }, 0);
    } else {
      Promise.reject(new Error("boom"));
    }

    setInterval(() => {}, 1_000);
  `;

  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  // Single owner of the stderr reader: pump chunks into `stderr` in the background so the
  // wait-for-marker loop below can just poll the accumulated string (sleeping between
  // checks) instead of racing reader.read() against timeouts, which risks orphaning a
  // pending read.
  let stderr = "";
  let streamClosed = false;
  const pumpDone = (async (): Promise<void> => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) stderr += decoder.decode(value, { stream: true });
        if (done) break;
      }
    } finally {
      streamClosed = true;
    }
  })();

  const fatalDeadline = Date.now() + FATAL_MARKER_TIMEOUT_MS;
  while (!FATAL_MARKER_PATTERN.test(stderr) && !streamClosed && Date.now() < fatalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Only now race a short, fixed window: with the fatal marker already observed (or the
  // stream already closed / the safety net expired), the only remaining uncertainty is
  // whether the OS has finished reporting the process's own exit -- a much smaller and
  // less load-sensitive gap than the boot time this used to be conflated with.
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({ exitCode, stillAliveAfterGrace: false })),
    new Promise<{ exitCode: number | null; stillAliveAfterGrace: true }>((resolve) =>
      setTimeout(() => {
        resolve({ exitCode: null, stillAliveAfterGrace: true });
      }, graceMs),
    ),
  ]);

  if (outcome.stillAliveAfterGrace) {
    proc.kill("SIGTERM");
    await proc.exited;
  }

  await pumpDone;
  return {
    exitCode: outcome.exitCode,
    signal: proc.signalCode,
    stderr,
    stillAliveAfterGrace: outcome.stillAliveAfterGrace,
  };
}
