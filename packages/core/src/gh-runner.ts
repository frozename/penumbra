import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

export type GhRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type GhRunResult = { stdout: string; reason: null } | { stdout: null; reason: string };

export type RunGhInput = {
  cwd: string;
  args: string[];
  run?: GhRunner;
  timeoutMs?: number;
};

const execFile = promisify(execFileCb);
const DEFAULT_TIMEOUT_MS = 5_000;
// PR search results carry full bodies; execFile's 1 MiB default would truncate them into an error.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NOT_GITHUB_RE = /not a git repository|no git remotes found|none of the git remotes/i;

const defaultRun: GhRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, maxBuffer: MAX_BUFFER_BYTES });

function timedOut(command: string, timeoutMs: number): string {
  return `${command} timed out after ${String(timeoutMs)}ms`;
}

function describeFailure(command: string, err: unknown, timeoutMs: number): string {
  const fields = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  if (fields.code === "ENOENT") return "gh not installed";
  if (fields.killed === true) return timedOut(command, timeoutMs);
  const stderr = typeof fields.stderr === "string" ? fields.stderr : "";
  if (NOT_GITHUB_RE.test(stderr)) return "not a GitHub repository";
  const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
  const detail = firstLine ?? (err instanceof Error ? err.message : String(err));
  return `${command} failed: ${detail.trim().slice(0, 200)}`;
}

export async function runGh(input: RunGhInput): Promise<GhRunResult> {
  const run = input.run ?? defaultRun;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = ["gh", ...input.args.slice(0, 2)].join(" ");
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The runner gets the timeout too so a real gh child is killed; the race bounds runners that ignore it.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([
      run("gh", input.args, { cwd: input.cwd, timeout: timeoutMs }),
      deadline,
    ]);
    return out === null
      ? { stdout: null, reason: timedOut(command, timeoutMs) }
      : { stdout: out.stdout, reason: null };
  } catch (err) {
    return { stdout: null, reason: describeFailure(command, err, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}
