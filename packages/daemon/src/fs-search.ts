import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';

const GLOB_DEFAULT_MAX = 1000;
const GLOB_HARD_CEILING = 5000;

export interface GlobArgs {
  pattern: string;
  path?: string | null;
  max_results?: number | null;
  include_ignored?: boolean | null;
}

export interface GlobResult {
  results: string[];
  truncated: boolean;
}

interface PathWithMtime {
  rel: string;
  mtimeMs: number;
}

async function readGitignore(root: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    return ignore().add(content);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function executeGlob(args: GlobArgs, worktree: string): Promise<GlobResult> {
  const defaultMax = GLOB_DEFAULT_MAX;
  const cap = Math.min(args.max_results ?? defaultMax, GLOB_HARD_CEILING);
  const searchRoot = args.path ? path.resolve(worktree, args.path) : worktree;
  const gitignore = args.include_ignored ? null : await readGitignore(worktree);
  const glob = new Bun.Glob(args.pattern);
  const collected: PathWithMtime[] = [];

  for (const rel of glob.scanSync({ cwd: searchRoot, onlyFiles: true, absolute: false })) {
    const abs = path.resolve(searchRoot, rel);
    const relFromWorktree = path.relative(worktree, abs);
    if (gitignore?.ignores(relFromWorktree)) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    collected.push({ rel: relFromWorktree, mtimeMs: stat.mtimeMs });
  }

  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = collected.length > cap;
  return {
    results: collected.slice(0, cap).map((entry) => entry.rel),
    truncated,
  };
}
