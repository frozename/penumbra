import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class FsPathError extends Error {
  constructor(
    public readonly code: 'outside_worktree' | 'not_found' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'FsPathError';
  }
}

export async function resolveInsideWorktree(userPath: string, worktree: string): Promise<string> {
  const worktreeAbs = path.resolve(worktree);
  const worktreeReal = await fs.realpath(worktreeAbs);
  const candidate = path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(worktreeAbs, userPath);

  const relToWorktree = path.relative(worktreeAbs, candidate);
  if (relToWorktree.startsWith('..') || path.isAbsolute(relToWorktree)) {
    throw new FsPathError(
      'outside_worktree',
      `path "${userPath}" resolves outside worktree (real path: ${candidate})`,
    );
  }

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new FsPathError('not_found', `file not found: ${userPath}`);
    }
    throw new FsPathError('io', `failed to resolve ${userPath}: ${err?.message ?? String(err)}`);
  }

  const rel = path.relative(worktreeReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FsPathError(
      'outside_worktree',
      `path "${userPath}" resolves outside worktree (real path: ${real})`,
    );
  }

  return real;
}
