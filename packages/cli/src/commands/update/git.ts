import { type CiPort, type CiState, type Exec, type GitPort, UpdateError } from "./types.js";

const DEPENDENCY_PATHS = [
  "bun.lock",
  "package.json",
  "packages/*/package.json",
  "packages/integrations/*/package.json",
];
const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Every call skips optional locks (a read never takes index.lock from a concurrent
 * land) and runs without hooks (the service checkout's hooks are not ours to run).
 */
function gitArgv(dir: string, args: string[]): string[] {
  return ["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-C", dir, ...args];
}

export function createGitPort(exec: Exec, dir: string): GitPort {
  const git = async (args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> => {
    const res = await exec(gitArgv(dir, args), { timeoutMs });
    if (res.code !== 0) {
      throw new UpdateError(
        `git ${args.join(" ")} failed (exit ${String(res.code)}): ${firstLine(res.stderr)}`,
      );
    }
    return res.stdout;
  };
  const exitCode = async (args: string[]): Promise<number> =>
    (await exec(gitArgv(dir, args), { timeoutMs: GIT_TIMEOUT_MS })).code;

  const port: GitPort = {
    topLevel: async () => (await git(["rev-parse", "--show-toplevel"])).trim(),
    branch: async () => {
      const res = await exec(gitArgv(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
      return res.code === 0 ? res.stdout.trim() || null : null;
    },
    fetch: async (ref) => {
      const remoteBranch = /^origin\/(.+)$/.exec(ref)?.[1];
      const args = remoteBranch ? ["origin", remoteBranch] : ["origin"];
      await git(["fetch", "--quiet", ...args], FETCH_TIMEOUT_MS);
    },
    resolve: async (ref) => {
      const res = await exec(gitArgv(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
      return res.code === 0 ? res.stdout.trim() || null : null;
    },
    head: async () => (await git(["rev-parse", "HEAD"])).trim(),
    isAncestor: async (ancestor, descendant) =>
      (await exitCode(["merge-base", "--is-ancestor", ancestor, descendant])) === 0,
    log: async (from, to, limit) => {
      const count = Number((await git(["rev-list", "--count", `${from}..${to}`])).trim());
      const out = await git([
        "log",
        "--oneline",
        "--no-decorate",
        `--max-count=${String(limit)}`,
        `${from}..${to}`,
      ]);
      return { count, lines: out.split("\n").filter((line) => line.trim() !== "") };
    },
    depsChanged: async (from, to) => {
      const code = await exitCode(["diff", "--quiet", from, to, "--", ...DEPENDENCY_PATHS]);
      if (code > 1) throw new UpdateError(`git diff ${from} ${to} failed (exit ${String(code)})`);
      return code === 1;
    },
    trackedChanges: async () =>
      (await git(["status", "--porcelain", "--untracked-files=no"]))
        .split("\n")
        .filter((line) => line.trim() !== ""),
    fastForward: async (to) => {
      await git(["merge", "--ff-only", "--quiet", to]);
    },
    resetHard: async (to) => {
      await git(["reset", "--quiet", "--hard", to]);
    },
  };
  return port;
}

interface GhRun {
  status?: unknown;
  conclusion?: unknown;
}

export function parseGhRunState(stdout: string): CiState {
  let runs: unknown;
  try {
    runs = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(runs)) return "unknown";
  const run = runs[0] as GhRun | undefined;
  if (run === undefined) return "none";
  if (run.status !== "completed") return "pending";
  return typeof run.conclusion === "string" && run.conclusion !== "" ? run.conclusion : "unknown";
}

/** The target's `check` workflow conclusion via `gh`; "unknown" when gh is missing or fails. */
export function createCiPort(exec: Exec, repo: string): CiPort {
  const port: CiPort = {
    state: async (sha) => {
      const res = await exec(
        [
          "gh",
          "run",
          "list",
          "--commit",
          sha,
          "--workflow",
          "check",
          "--limit",
          "1",
          "--json",
          "status,conclusion",
        ],
        { cwd: repo, timeoutMs: 30_000 },
      );
      return res.code === 0 ? parseGhRunState(res.stdout) : "unknown";
    },
  };
  return port;
}
