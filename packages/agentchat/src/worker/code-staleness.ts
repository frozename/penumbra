import { execFile, execFileSync } from "node:child_process";

export type WorkerCodeShaResult =
  | { status: "resolved"; sha: string }
  | { status: "unknown"; sha: null; reason: string };

export type WorkerCodeStaleness =
  | { status: "stale"; stale: true }
  | { status: "current"; stale: false }
  | { status: "unknown"; stale: false };

export const WORKER_CODE_SHA_GIT_TIMEOUT_MS = 5_000;
export const WORKER_CODE_STALENESS_CHECK_INTERVAL_MS = 5 * 60_000;
const GIT_SHA_RE = /^[a-f0-9]{40,64}$/i;

interface WorkerCodeShaExecOptions {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
  timeout: number;
  killSignal: "SIGKILL";
}

interface WorkerCodeShaAsyncExecOptions {
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGKILL";
}

export type WorkerCodeShaExecFileSync = (
  file: string,
  args: readonly string[],
  options: WorkerCodeShaExecOptions,
) => string;

export type WorkerCodeShaExecFile = (
  file: string,
  args: readonly string[],
  options: WorkerCodeShaAsyncExecOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface WorkerCodeShaDeps {
  execFileSync?: WorkerCodeShaExecFileSync;
  execFile?: WorkerCodeShaExecFile;
}

function stripUrlCredentials(message: string): string {
  return message.replaceAll(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@([^\s]+)/gi, "$1$2");
}

function cleanErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return stripUrlCredentials(err.message);
  const text = String(err).trim();
  return text ? stripUrlCredentials(text) : "unknown error";
}

function normalizeSha(sha: string | null | undefined): string | null {
  const trimmed = sha?.trim();
  if (!trimmed || !GIT_SHA_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function resolveWorkerCodeSha(
  repoRoot: string,
  deps: WorkerCodeShaDeps = {},
): WorkerCodeShaResult {
  const run: WorkerCodeShaExecFileSync =
    deps.execFileSync ?? ((file, args, options): string => execFileSync(file, args, options));
  try {
    const output = run("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WORKER_CODE_SHA_GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const sha = normalizeSha(output);
    if (sha === null) {
      return { status: "unknown", sha: null, reason: "git returned an invalid HEAD sha" };
    }
    return { status: "resolved", sha };
  } catch (err) {
    return { status: "unknown", sha: null, reason: cleanErrorMessage(err) };
  }
}

export async function resolveWorkerCodeShaAsync(
  repoRoot: string,
  deps: WorkerCodeShaDeps = {},
): Promise<WorkerCodeShaResult> {
  const run: WorkerCodeShaExecFile =
    deps.execFile ??
    ((file, args, options, callback): void => {
      execFile(file, [...args], options, callback);
    });
  return await new Promise<WorkerCodeShaResult>((resolve) => {
    run(
      "git",
      ["-C", repoRoot, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
        timeout: WORKER_CODE_SHA_GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (err, stdout) => {
        if (err) {
          resolve({ status: "unknown", sha: null, reason: cleanErrorMessage(err) });
          return;
        }
        const sha = normalizeSha(stdout);
        if (sha === null) {
          resolve({ status: "unknown", sha: null, reason: "git returned an invalid HEAD sha" });
          return;
        }
        resolve({ status: "resolved", sha });
      },
    );
  });
}

export function shouldCheckWorkerCodeStaleness(input: {
  lastCheckedAtMs: number | null;
  nowMs: number;
  intervalMs?: number;
}): boolean {
  if (input.lastCheckedAtMs === null) return true;
  const intervalMs = input.intervalMs ?? WORKER_CODE_STALENESS_CHECK_INTERVAL_MS;
  return input.nowMs < input.lastCheckedAtMs || input.nowMs - input.lastCheckedAtMs >= intervalMs;
}

export function assessWorkerCodeStaleness(input: {
  bootSha: string | null | undefined;
  currentSha: string | null | undefined;
}): WorkerCodeStaleness {
  const bootSha = normalizeSha(input.bootSha);
  const currentSha = normalizeSha(input.currentSha);
  if (bootSha === null || currentSha === null) return { status: "unknown", stale: false };
  if (bootSha !== currentSha) return { status: "stale", stale: true };
  return { status: "current", stale: false };
}
