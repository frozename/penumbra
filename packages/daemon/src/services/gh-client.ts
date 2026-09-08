export type GhIssueState = "OPEN" | "CLOSED";
export type GhIssueStateReason = "COMPLETED" | "NOT_PLANNED" | null;

export interface GhIssueView {
  number: number;
  state: GhIssueState;
  stateReason: GhIssueStateReason;
  updatedAt: string;
  title: string;
  url: string;
}

export interface GhPullRequestLite {
  number: number;
}

export interface GhPullRequestView {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommitOid: string | null;
}

export interface GhOpenPullRequest {
  number: number;
  title?: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
}

export interface GhClosePullRequestInput {
  number: number;
  comment: string;
  deleteBranch?: boolean;
}

export interface GhLabelPullRequestInput {
  number: number;
  labels: string[];
  comment?: string;
}

export interface GhMergePullRequestInput {
  number: number;
  method: "squash" | "merge" | "rebase";
  subject?: string;
  body?: string;
  deleteBranch?: boolean;
}

export interface GhCreateIssueInput {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface GhIssueComment {
  id: string;
  author_login: string;
  body: string;
  created_at: string;
  url: string;
}

export interface GhClient {
  createIssue(input: GhCreateIssueInput): Promise<{ number: number; url: string }>;
  viewIssue(repo: string, issueNumber: number): Promise<GhIssueView>;
  closeIssue(repo: string, issueNumber: number, reason: "completed" | "not planned"): Promise<void>;
  reopenIssue(repo: string, issueNumber: number): Promise<void>;
  commentIssue(repo: string, issueNumber: number, body: string): Promise<{ comment_url: string }>;
  listComments(
    repo: string,
    issueNumber: number,
    opts?: { since?: string },
  ): Promise<GhIssueComment[]>;
  getAuthenticatedLogin?(): Promise<string | null>;
  listOpenPullRequests?(): Promise<GhOpenPullRequest[]>;
  listOpenPullRequestsByHead?(headRefName: string): Promise<GhPullRequestLite[]>;
  closePullRequest?(input: GhClosePullRequestInput): Promise<void>;
  labelPullRequest?(input: GhLabelPullRequestInput): Promise<void>;
  mergePullRequest?(input: GhMergePullRequestInput): Promise<void>;
  getPullRequest?(prNumber: number): Promise<GhPullRequestView>;
}

interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhExec = (args: string[]) => Promise<GhExecResult>;

export const GH_EXEC_TIMEOUT_MS = 120_000;

function normalizeState(value: string): GhIssueState {
  return value.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
}

function normalizeReason(value: unknown): GhIssueStateReason {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  if (upper === "COMPLETED") return "COMPLETED";
  if (upper === "NOT_PLANNED") return "NOT_PLANNED";
  return null;
}

async function defaultExec(
  args: string[],
  cwd?: string,
  timeoutMs = GH_EXEC_TIMEOUT_MS,
): Promise<GhExecResult> {
  // Bun.spawn (NOT spawnSync): `gh` makes a network round-trip to GitHub
  // (~0.6s each). spawnSync blocks the daemon's single-threaded event loop for
  // that whole duration, so a sweep that runs N `gh` calls back-to-back (e.g.
  // gh-task-sync re-syncing every linked task) stalls ALL HTTP — including the
  // worker's per-dispatch capture observes — for ~N×0.6s. spawn yields the loop
  // while the subprocess runs, letting requests interleave. Read both pipes
  // concurrently with `exited` to drain the buffers and avoid a pipe deadlock.
  const proc = Bun.spawn({
    cmd: ["gh", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timedOutFlag = { value: false };
  const timeout = setTimeout(() => {
    timedOutFlag.value = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOutFlag.value) {
      const timeoutMessage = `gh ${args.join(" ")} timed out after ${String(timeoutMs)}ms`;
      const trimmed = stderr.trim();
      return {
        stdout,
        stderr: trimmed ? `${trimmed}\n${timeoutMessage}` : timeoutMessage,
        exitCode: exitCode === 0 ? 124 : exitCode,
      };
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

async function runOrThrow(exec: GhExec, args: string[]): Promise<string> {
  const out = await exec(args);
  if (out.exitCode !== 0) {
    const stderr = out.stderr.trim();
    throw new Error(
      stderr ? `gh ${args.join(" ")} failed: ${stderr}` : `gh ${args.join(" ")} failed`,
    );
  }
  return out.stdout.trim();
}

function parseIssueUrlFromOutput(output: string): { number: number; url: string } | null {
  const match = /https?:\/\/\S+\/issues\/(\d+)\b/.exec(output);
  if (!match) return null;
  const issueNumber = Number(match[1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  return {
    number: issueNumber,
    url: match[0],
  };
}

function extractFirstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s)]+/.exec(text);
  return match?.[0] ?? null;
}

function extractUnknownLabels(stderr: string): string[] {
  const labels = new Set<string>();
  const pattern = /could not add label: '([^']+)' not found/g;
  for (let match = pattern.exec(stderr); match !== null; match = pattern.exec(stderr)) {
    const label = match[1];
    if (label !== undefined) labels.add(label);
  }
  return [...labels];
}

type RawCommentRow = {
  id?: unknown;
  user?: { login?: unknown };
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  url?: unknown;
};

function parseRawComment(item: unknown): GhIssueComment | null {
  if (!item || typeof item !== "object") return null;
  const row = item as RawCommentRow;
  const rawId = row.id;
  const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
  return {
    id,
    author_login: typeof row.user?.login === "string" ? row.user.login : "",
    body: typeof row.body === "string" ? row.body : "",
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    url:
      typeof row.html_url === "string" ? row.html_url : typeof row.url === "string" ? row.url : "",
  };
}

function parseGhIssueComments(text: string): GhIssueComment[] {
  const parsed = JSON.parse(text || "[]") as unknown;
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const comments: GhIssueComment[] = [];

  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const item of page) {
      const comment = parseRawComment(item);
      if (comment) comments.push(comment);
    }
  }

  return comments;
}

async function ghCreateIssue(
  exec: GhExec,
  input: GhCreateIssueInput,
): Promise<{ number: number; url: string }> {
  const baseArgs = ["issue", "create", "--repo", input.repo, "--title", input.title];
  if (input.body !== undefined) {
    baseArgs.push("--body", input.body);
  }
  for (const label of input.labels ?? []) {
    baseArgs.push("--label", label);
  }
  for (const assignee of input.assignees ?? []) {
    baseArgs.push("--assignee", assignee);
  }
  const out = await runCreateIssueWithLabelRetry(exec, baseArgs, input.repo);
  const parsed = parseIssueUrlFromOutput(out);
  if (!parsed) {
    throw new Error(`gh issue create did not print an issue URL: ${out}`);
  }
  return parsed;
}

async function ghCommentIssue(
  exec: GhExec,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ comment_url: string }> {
  const text = await runOrThrow(exec, [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    body,
  ]);
  const comment_url = extractFirstUrl(text);
  if (!comment_url) {
    throw new Error(
      `gh issue comment ${String(issueNumber)} --repo ${repo} did not return a comment URL`,
    );
  }
  return { comment_url };
}

export function createGhCliClient(
  opts: { exec?: GhExec; repoDir?: string; execTimeoutMs?: number } = {},
): GhClient {
  const exec: GhExec =
    opts.exec ??
    ((args: string[]): Promise<GhExecResult> =>
      defaultExec(args, opts.repoDir, opts.execTimeoutMs));
  return {
    createIssue: (input) => ghCreateIssue(exec, input),

    async viewIssue(repo: string, issueNumber: number): Promise<GhIssueView> {
      const text = await runOrThrow(exec, [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "number,state,stateReason,updatedAt,title,url",
      ]);
      const p = JSON.parse(text) as {
        number: number;
        state: string;
        stateReason?: unknown;
        updatedAt: string;
        title: string;
        url: string;
      };
      return {
        number: p.number,
        state: normalizeState(p.state),
        stateReason: normalizeReason(p.stateReason),
        updatedAt: p.updatedAt,
        title: p.title,
        url: p.url,
      };
    },

    async closeIssue(
      repo: string,
      issueNumber: number,
      reason: "completed" | "not planned",
    ): Promise<void> {
      await runOrThrow(exec, [
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repo,
        "--reason",
        reason,
      ]);
    },

    async reopenIssue(repo: string, issueNumber: number): Promise<void> {
      await runOrThrow(exec, ["issue", "reopen", String(issueNumber), "--repo", repo]);
    },

    commentIssue: (repo, issueNumber, body) => ghCommentIssue(exec, repo, issueNumber, body),

    async listComments(
      repo: string,
      issueNumber: number,
      opts?: { since?: string },
    ): Promise<GhIssueComment[]> {
      const sinceQuery = opts?.since ? `?since=${encodeURIComponent(opts.since)}` : "";
      const text = await runOrThrow(exec, [
        "api",
        `repos/${repo}/issues/${String(issueNumber)}/comments${sinceQuery}`,
        "--paginate",
        "--slurp",
      ]);
      return parseGhIssueComments(text);
    },

    async getAuthenticatedLogin(): Promise<string | null> {
      const text = await runOrThrow(exec, ["api", "user", "--jq", ".login"]);
      const login = text.trim();
      return login.length > 0 ? login : null;
    },

    async listOpenPullRequests(): Promise<GhOpenPullRequest[]> {
      const text = await runOrThrow(exec, [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,headRefName,headRefOid,updatedAt",
        "--limit",
        "500",
      ]);
      return JSON.parse(text || "[]") as GhOpenPullRequest[];
    },

    async listOpenPullRequestsByHead(headRefName: string): Promise<GhPullRequestLite[]> {
      const text = await runOrThrow(exec, [
        "pr",
        "list",
        "--head",
        headRefName,
        "--state",
        "open",
        "--json",
        "number",
      ]);
      const parsed = JSON.parse(text) as { number: number }[];
      return parsed.map((row) => ({ number: row.number }));
    },

    async closePullRequest(input: GhClosePullRequestInput): Promise<void> {
      const args = ["pr", "close", String(input.number), "--comment", input.comment];
      if (input.deleteBranch) args.push("--delete-branch");
      await runOrThrow(exec, [...args]);
    },

    async mergePullRequest(input: GhMergePullRequestInput): Promise<void> {
      const args = ["pr", "merge", String(input.number), `--${input.method}`];
      if (input.subject) args.push("--subject", input.subject);
      if (input.body) args.push("--body", input.body);
      if (input.deleteBranch) args.push("--delete-branch");
      await runOrThrow(exec, [...args]);
    },

    getPullRequest: (prNumber) => ghGetPullRequest(exec, prNumber),

    labelPullRequest: (input) => ghLabelPullRequest(exec, input),
  };
}

async function ghLabelPullRequest(exec: GhExec, input: GhLabelPullRequestInput): Promise<void> {
  const editArgs = ["pr", "edit", String(input.number)];
  for (const label of input.labels) editArgs.push("--add-label", label);
  await runOrThrow(exec, editArgs);
  if (input.comment !== undefined && input.comment.length > 0) {
    await runOrThrow(exec, ["pr", "comment", String(input.number), "--body", input.comment]);
  }
}

async function ghGetPullRequest(exec: GhExec, prNumber: number): Promise<GhPullRequestView> {
  const text = await runOrThrow(exec, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "state,mergeCommit",
  ]);
  const p = JSON.parse(text) as { state: string; mergeCommit: { oid: string } | null };
  const upper = p.state.toUpperCase();
  const state: GhPullRequestView["state"] =
    upper === "MERGED" ? "MERGED" : upper === "CLOSED" ? "CLOSED" : "OPEN";
  return {
    number: prNumber,
    state,
    mergeCommitOid: p.mergeCommit?.oid ?? null,
  };
}

async function runCreateIssueWithLabelRetry(
  exec: GhExec,
  args: string[],
  repo: string,
): Promise<string> {
  try {
    return await runOrThrow(exec, args);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const unknownLabels = extractUnknownLabels(error.message);
    if (unknownLabels.length === 0) throw error;

    console.warn(
      `gh-client: dropping unknown labels: ${JSON.stringify(unknownLabels)} for repo=${repo}`,
    );
    const filteredArgs = filterIssueCreateLabels(args, new Set(unknownLabels));
    return await runOrThrow(exec, filteredArgs);
  }
}

function filterIssueCreateLabels(args: string[], labelsToDrop: Set<string>): string[] {
  if (labelsToDrop.size === 0) return args;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const nextArg = args[i + 1];
    if (arg === "--label" && nextArg !== undefined && labelsToDrop.has(nextArg)) {
      i += 1;
      continue;
    }
    if (arg !== undefined) filtered.push(arg);
  }
  return filtered;
}
