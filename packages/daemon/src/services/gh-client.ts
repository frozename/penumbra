export type GhIssueState = 'OPEN' | 'CLOSED';
export type GhIssueStateReason = 'COMPLETED' | 'NOT_PLANNED' | null;

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

export interface GhClient {
  viewIssue(repo: string, issueNumber: number): Promise<GhIssueView>;
  closeIssue(repo: string, issueNumber: number, reason: 'completed' | 'not planned'): Promise<void>;
  reopenIssue(repo: string, issueNumber: number): Promise<void>;
  listOpenPullRequestsByHead?(headRefName: string): Promise<GhPullRequestLite[]>;
  closePullRequest?(prNumber: number, input: { comment: string }): Promise<void>;
}

interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhExec = (args: string[]) => Promise<GhExecResult>;

function normalizeState(value: string): GhIssueState {
  return value.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

function normalizeReason(value: unknown): GhIssueStateReason {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  if (upper === 'COMPLETED') return 'COMPLETED';
  if (upper === 'NOT_PLANNED') return 'NOT_PLANNED';
  return null;
}

async function defaultExec(args: string[]): Promise<GhExecResult> {
  const proc = Bun.spawnSync({
    cmd: ['gh', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

async function runOrThrow(exec: GhExec, args: string[]): Promise<string> {
  const out = await exec(args);
  if (out.exitCode !== 0) {
    const stderr = out.stderr.trim();
    throw new Error(stderr ? `gh ${args.join(' ')} failed: ${stderr}` : `gh ${args.join(' ')} failed`);
  }
  return out.stdout.trim();
}

export function createGhCliClient(opts: { exec?: GhExec } = {}): GhClient {
  const exec = opts.exec ?? defaultExec;
  return {
    async viewIssue(repo: string, issueNumber: number): Promise<GhIssueView> {
      const text = await runOrThrow(exec, [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'number,state,stateReason,updatedAt,title,url',
      ]);
      const parsed = JSON.parse(text) as {
        number: number;
        state: string;
        stateReason?: unknown;
        updatedAt: string;
        title: string;
        url: string;
      };
      return {
        number: parsed.number,
        state: normalizeState(parsed.state),
        stateReason: normalizeReason(parsed.stateReason),
        updatedAt: parsed.updatedAt,
        title: parsed.title,
        url: parsed.url,
      };
    },

    async closeIssue(repo: string, issueNumber: number, reason: 'completed' | 'not planned'): Promise<void> {
      await runOrThrow(exec, [
        'issue',
        'close',
        String(issueNumber),
        '--repo',
        repo,
        '--reason',
        reason,
      ]);
    },

    async reopenIssue(repo: string, issueNumber: number): Promise<void> {
      await runOrThrow(exec, [
        'issue',
        'reopen',
        String(issueNumber),
        '--repo',
        repo,
      ]);
    },

    async listOpenPullRequestsByHead(headRefName: string): Promise<GhPullRequestLite[]> {
      const text = await runOrThrow(exec, [
        'pr',
        'list',
        '--head',
        headRefName,
        '--state',
        'open',
        '--json',
        'number',
      ]);
      const parsed = JSON.parse(text) as Array<{ number: number }>;
      return parsed.map((row) => ({ number: row.number }));
    },

    async closePullRequest(prNumber: number, input: { comment: string }): Promise<void> {
      await runOrThrow(exec, [
        'pr',
        'close',
        String(prNumber),
        '--comment',
        input.comment,
      ]);
    },
  };
}
