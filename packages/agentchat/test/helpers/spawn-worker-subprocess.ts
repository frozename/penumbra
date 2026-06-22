import { fileURLToPath } from "node:url";

export type WorkerCrashFault = "unhandledRejection" | "uncaughtException";

export interface WorkerCrashGuardSubprocessResult {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stillAliveAfterGrace: boolean;
}

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

  const stderr = await new Response(proc.stderr).text();
  return {
    exitCode: outcome.exitCode,
    signal: proc.signalCode,
    stderr,
    stillAliveAfterGrace: outcome.stillAliveAfterGrace,
  };
}
