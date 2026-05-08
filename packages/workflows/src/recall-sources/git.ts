import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

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
  commits: Array<{ sha: string; subject: string; body: string; ts: string }>;
  warnings: string[];
};

function quoteRange(range?: string, since?: string): string {
  if (range) return ` ${range}`;
  if (since) return ` --since=${JSON.stringify(since)}`;
  return '';
}

function truncateBody(body: string, maxChars = 2000): string {
  if (body.length <= maxChars) return body;
  let trimmed = body.slice(0, maxChars);
  if (!trimmed.endsWith('\n')) trimmed += '\n';
  return `${trimmed}[…truncated]\n`;
}

export async function runGitLog(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  const fmt = args.format ?? '%h %s';
  const cmd = `git -C "${cwd}" log --pretty=format:"${fmt}"${quoteRange(args.range, args.since)}${args.pathspec ? ` -- ${args.pathspec}` : ''}`;
  try {
    const { stdout } = await exec(cmd);
    return { text: stdout, warnings: [] };
  } catch (err: any) {
    return { text: '', warnings: [`git.log: ${err?.message ?? String(err)}`] };
  }
}

export async function runGitDiff(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  const cmd = `git -C "${cwd}" diff${args.range ? ` ${args.range}` : ''}${args.pathspec ? ` -- ${args.pathspec}` : ''}`;
  try {
    const { stdout } = await exec(cmd);
    return { text: stdout, warnings: [] };
  } catch (err: any) {
    return { text: '', warnings: [`git.diff: ${err?.message ?? String(err)}`] };
  }
}

export async function runGitShow(input: GitShowInput): Promise<GitShowOutput> {
  const { cwd, args } = input;
  const maxCommits = args.max_commits ?? 50;
  const cmd = `git -C "${cwd}" log --pretty=format:'%H%x00%s%x00%aI%x00%b%x1e' -n ${maxCommits}${quoteRange(args.range, args.since)}`;
  try {
    const { stdout } = await exec(cmd);
    const commits: GitShowOutput['commits'] = [];
    for (const record of stdout.split('\x1e')) {
      if (record.length === 0) continue;
      const [sha = '', subject = '', ts = '', body = ''] = record.replace(/^\n+/, '').split('\x00');
      if (sha.length === 0) continue;
      commits.push({ sha, subject, ts, body: truncateBody(body) });
    }
    return { commits, warnings: [] };
  } catch (err: any) {
    return { commits: [], warnings: [`git.show: ${err?.message ?? String(err)}`] };
  }
}
