import {
  type CommitIntegrityEvidence,
  DISPATCH_BASE_CONFIG_KEY,
  isAncestorOf,
  type WorktreeCommandRunner,
  type WorktreeCommandRunnerOptions,
} from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// dispatch.end meta must stay within 4096 chars (core dispatch-event-log
// throws past it), so only the first few mismatched SHAs are listed and
// mismatched_total carries the full count.
export const MISMATCHED_COMMITS_CAP = 10;
// Bounds `git log` output well under execFile's default 1 MiB maxBuffer.
export const LOG_SCAN_LIMIT = 1000;
// Worktree config is agent-writable; cap what an oversized identity can add.
export const IDENTITY_FIELD_MAX = 128;

// Identity overrides in the worker's environment must not decide the
// expected identity: git var then reports what git derives from config,
// which is what the worktree was provisioned with.
const IDENTITY_ENV_KEYS = new Set([
  "EMAIL",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
]);

const LOG_FORMAT = "--format=%H%x00%an%x00%ae%x00%cn%x00%ce";

interface GitIdent {
  name: string;
  email: string;
}

interface ExpectedIdents {
  author: GitIdent;
  committer: GitIdent;
}

export interface CommitIntegrityProbeDeps {
  runner?: WorktreeCommandRunner;
  env?: NodeJS.ProcessEnv;
}

const defaultRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: "utf8" });

function withoutIdentityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !IDENTITY_ENV_KEYS.has(key)));
}

async function gitOutput(
  runner: WorktreeCommandRunner,
  args: string[],
  opts: WorktreeCommandRunnerOptions,
): Promise<string | null> {
  try {
    return (await runner("git", args, opts)).stdout.trim();
  } catch {
    return null;
  }
}

async function readSha(
  runner: WorktreeCommandRunner,
  args: string[],
  opts: WorktreeCommandRunnerOptions,
): Promise<string | null> {
  const out = await gitOutput(runner, args, opts);
  return out !== null && SHA_RE.test(out) ? out : null;
}

// `git var GIT_AUTHOR_IDENT` prints "Name <email> <epoch> <tz>" after the same
// normalisation git applies when it writes a commit (trailing crud such as
// "," or ";" stripped), so it compares equal to %an/%ae of an honest commit.
function parseIdent(raw: string | null): GitIdent | null {
  if (raw === null) return null;
  const close = raw.lastIndexOf(">");
  const open = raw.lastIndexOf(" <", close);
  if (close < 0 || open < 0) return null;
  return { name: raw.slice(0, open), email: raw.slice(open + 2, close) };
}

async function readExpectedIdents(
  runner: WorktreeCommandRunner,
  opts: WorktreeCommandRunnerOptions,
): Promise<ExpectedIdents | null> {
  const [author, committer] = await Promise.all([
    gitOutput(runner, ["var", "GIT_AUTHOR_IDENT"], opts),
    gitOutput(runner, ["var", "GIT_COMMITTER_IDENT"], opts),
  ]);
  const authorIdent = parseIdent(author);
  const committerIdent = parseIdent(committer);
  if (!authorIdent || !committerIdent) return null;
  return { author: authorIdent, committer: committerIdent };
}

// Only commits unique to the dispatch branch count: anything reachable from
// another local branch or any remote-tracking ref (a newer main the agent
// rebased onto, or the parent branch of a stacked dispatch) was not created
// by this dispatch. The branch's own remote-tracking copies stay counted.
function branchOnlyLogArgs(baseSha: string, branchName: string): string[] {
  return [
    "log",
    "--first-parent",
    `--max-count=${String(LOG_SCAN_LIMIT)}`,
    LOG_FORMAT,
    `refs/heads/${branchName}`,
    `^${baseSha}`,
    "--not",
    `--exclude=${branchName}`,
    "--branches",
    `--exclude=*/${branchName}`,
    "--remotes",
    "--",
  ];
}

function mismatchedSha(line: string, expected: ExpectedIdents): string | null {
  const [sha = "", authorName, authorEmail, committerName, committerEmail] = line.split("\0");
  if (!SHA_RE.test(sha)) return null;
  const authorMatches =
    authorName === expected.author.name && authorEmail === expected.author.email;
  const committerMatches =
    committerName === expected.committer.name && committerEmail === expected.committer.email;
  return authorMatches && committerMatches ? null : sha;
}

async function listMismatchedCommits(
  runner: WorktreeCommandRunner,
  opts: WorktreeCommandRunnerOptions,
  range: { baseSha: string; branchName: string },
  expected: ExpectedIdents,
): Promise<string[] | null> {
  const log = await gitOutput(runner, branchOnlyLogArgs(range.baseSha, range.branchName), opts);
  if (log === null) return null;
  return log
    .split("\n")
    .map((line) => mismatchedSha(line, expected))
    .filter((sha): sha is string => sha !== null);
}

function displayIdentity(ident: GitIdent | undefined): GitIdent {
  return {
    name: (ident?.name ?? "").slice(0, IDENTITY_FIELD_MAX),
    email: (ident?.email ?? "").slice(0, IDENTITY_FIELD_MAX),
  };
}

/**
 * Evidence about the dispatch branch — the ref the reconciler and
 * dispatch_land land, not whatever HEAD points at. Null when the base or the
 * branch cannot be resolved. Once ancestry is known it is always reported;
 * a failed identity check leaves mismatched_total null instead of
 * discarding the base verdict.
 */
export async function probeCommitIntegrity(
  wtPath: string,
  branchName: string,
  deps: CommitIntegrityProbeDeps = {},
): Promise<CommitIntegrityEvidence | null> {
  const baseRunner = deps.runner ?? defaultRunner;
  const env = withoutIdentityEnv(deps.env ?? process.env);
  // isAncestorOf passes only cwd, so the env is applied here: every git call,
  // the shared ancestry helper included, sees the same environment.
  const runner: WorktreeCommandRunner = (cmd, args, runOpts) =>
    baseRunner(cmd, args, { ...runOpts, env });
  const opts = { cwd: wtPath };
  const baseSha = await readSha(runner, ["config", "--get", DISPATCH_BASE_CONFIG_KEY], opts);
  const headSha = await readSha(
    runner,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    opts,
  );
  if (baseSha === null || headSha === null) return null;

  let baseIsAncestor: boolean;
  try {
    baseIsAncestor = await isAncestorOf(runner, wtPath, baseSha, headSha);
  } catch {
    return null;
  }

  const expected = await readExpectedIdents(runner, opts);
  const mismatched = expected
    ? await listMismatchedCommits(runner, opts, { baseSha, branchName }, expected)
    : null;
  return {
    base_sha: baseSha,
    head_sha: headSha,
    base_is_ancestor: baseIsAncestor,
    identity: displayIdentity(expected?.author),
    mismatched_commits: mismatched?.slice(0, MISMATCHED_COMMITS_CAP) ?? [],
    mismatched_total: mismatched?.length ?? null,
  };
}
