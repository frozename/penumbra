import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

export type GitSourceInput = {
  cwd: string;
  args: { range?: string; since?: string; format?: string; pathspec?: string };
};

export type GitSourceOutput = { text: string; warnings: string[] };

function quoteRange(range?: string, since?: string): string {
  if (range) return ` ${range}`;
  if (since) return ` --since=${JSON.stringify(since)}`;
  return '';
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
