import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type GitSourceInput = {
  cwd: string;
  args: { range?: string; since?: string; format?: string; pathspec?: string };
};

export type GitSourceOutput = { text: string; warnings: string[] };
export type GitShowInput = {
  cwd: string;
  args: { range?: string; since?: string; max_commits?: number };
};
export type GitShowOutput = {
  commits: { sha: string; subject: string; body: string; ts: string }[];
  warnings: string[];
};

const REF_TOKEN_RE = /^[A-Za-z0-9._/^~-]{1,200}$/;

function hasForbiddenRefChars(value: string): boolean {
  return value.includes("\0") || value.includes("\n") || value.includes("\r");
}

function isValidGitRefToken(token: string): boolean {
  if (token.length === 0 || token.length > 200) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("../")) return false;
  if (token.includes("..")) return false;
  if (hasForbiddenRefChars(token)) return false;
  return REF_TOKEN_RE.test(token);
}

export function isValidGitRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length === 0) return false;
  if (value.startsWith("--")) return false;
  if (hasForbiddenRefChars(value)) return false;

  const tripleIdx = value.indexOf("...");
  if (tripleIdx !== -1) {
    if (tripleIdx !== value.lastIndexOf("...")) return false;
    const left = value.slice(0, tripleIdx);
    const right = value.slice(tripleIdx + 3);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  const doubleIdx = value.indexOf("..");
  if (doubleIdx !== -1) {
    if (doubleIdx !== value.lastIndexOf("..")) return false;
    const left = value.slice(0, doubleIdx);
    const right = value.slice(doubleIdx + 2);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  return isValidGitRefToken(value);
}

function isValidGitSince(since: string): boolean {
  const value = since.trim();
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("-")) return false;
  if (hasForbiddenRefChars(value)) return false;
  return true;
}

function isValidGitPathspec(pathspec: string): boolean {
  const value = pathspec.trim();
  if (value.length === 0) return false;
  if (value.startsWith("-")) return false;
  if (hasForbiddenRefChars(value)) return false;
  return true;
}

function isValidGitFormat(format: string): boolean {
  if (format.length === 0) return false;
  if (hasForbiddenRefChars(format)) return false;
  if (format.includes("%x00")) return false;
  if (format.includes("%(")) return false;
  return true;
}

function hasInvalidGitInput(args: {
  range?: string;
  since?: string;
  pathspec?: string;
  format?: string;
}): boolean {
  if (args.range !== undefined && !isValidGitRef(args.range)) return true;
  if (args.since !== undefined && !isValidGitSince(args.since)) return true;
  if (args.pathspec !== undefined && !isValidGitPathspec(args.pathspec)) return true;
  return false;
}

function truncateBody(body: string, maxChars = 2000): string {
  if (body.length <= maxChars) return body;
  let trimmed = body.slice(0, maxChars);
  if (!trimmed.endsWith("\n")) trimmed += "\n";
  return `${trimmed}[…truncated]\n`;
}

export async function runGitLog(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { text: "", warnings: ["git.log: invalid ref"] };
  }
  if (args.format !== undefined && !isValidGitFormat(args.format)) {
    return { text: "", warnings: ["git.log: invalid format"] };
  }
  const fmt = args.format ?? "%h %s";
  const gitArgs = ["-C", cwd, "log", `--pretty=format:${fmt}`];
  if (args.range) {
    gitArgs.push(args.range);
  } else if (args.since) {
    gitArgs.push(`--since=${args.since}`);
  }
  if (args.pathspec) {
    gitArgs.push("--", args.pathspec);
  }
  try {
    const { stdout } = await execFile("git", gitArgs);
    return { text: stdout, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", warnings: [`git.log: ${msg}`] };
  }
}

export async function runGitDiff(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { text: "", warnings: ["git.diff: invalid ref"] };
  }
  const gitArgs = ["-C", cwd, "diff"];
  if (args.range) gitArgs.push(args.range);
  if (args.pathspec) gitArgs.push("--", args.pathspec);
  try {
    const { stdout } = await execFile("git", gitArgs);
    return { text: stdout, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", warnings: [`git.diff: ${msg}`] };
  }
}

export async function runGitShow(input: GitShowInput): Promise<GitShowOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { commits: [], warnings: ["git.show: invalid ref"] };
  }
  const maxCommits = args.max_commits ?? 50;
  const gitArgs = [
    "-C",
    cwd,
    "log",
    "--pretty=format:%H%x00%s%x00%aI%x00%b%x1e",
    "-n",
    String(maxCommits),
  ];
  if (args.range) {
    gitArgs.push(args.range);
  } else if (args.since) {
    gitArgs.push(`--since=${args.since}`);
  }
  try {
    const { stdout } = await execFile("git", gitArgs);
    const commits: GitShowOutput["commits"] = [];
    for (const record of stdout.split("\x1e")) {
      if (record.length === 0) continue;
      const [sha = "", subject = "", ts = "", body = ""] = record.replace(/^\n+/, "").split("\x00");
      if (sha.length === 0) continue;
      commits.push({ sha, subject, ts, body: truncateBody(body) });
    }
    return { commits, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { commits: [], warnings: [`git.show: ${msg}`] };
  }
}
