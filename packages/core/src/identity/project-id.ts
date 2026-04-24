import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ProjectResolution =
  | { kind: 'git'; project_id: string; git_remote: string; git_relpath_root: string; repo_root: string }
  | { kind: 'marker'; project_id: string; marker_uuid: string; marker_path: string }
  | { kind: 'declared'; project_id: string }
  | { kind: 'quarantine'; project_id: null };

export interface ResolveOpts {
  cwd: string;
  declaredProjectId?: string;
  markerFileName?: string;
}

const DEFAULT_MARKER = '.penumbra-project';

export function resolveProjectId(opts: ResolveOpts): ProjectResolution {
  if (opts.declaredProjectId) return { kind: 'declared', project_id: opts.declaredProjectId };

  const git = tryGit(opts.cwd);
  if (git) {
    const hash = createHash('sha256').update(git.remote).digest('hex').slice(0, 16);
    const realCwd = realpathSync(opts.cwd);
    const rel = toPosix(relative(git.root, realCwd)) || '.';
    return {
      kind: 'git',
      project_id: `${hash}:${rel}`,
      git_remote: git.remote,
      git_relpath_root: rel,
      repo_root: git.root,
    };
  }

  const marker = tryMarker(opts.cwd, opts.markerFileName ?? DEFAULT_MARKER);
  if (marker) {
    return { kind: 'marker', project_id: marker.uuid, marker_uuid: marker.uuid, marker_path: marker.path };
  }

  return { kind: 'quarantine', project_id: null };
}

function tryGit(cwd: string): { remote: string; root: string } | null {
  const topLevel = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (topLevel.status !== 0) return null;
  const root = topLevel.stdout.trim();
  if (!root) return null;
  const remote = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) return null;
  const url = remote.stdout.trim();
  if (!url) return null;
  return { remote: url, root };
}

function tryMarker(cwd: string, fileName: string): { uuid: string; path: string } | null {
  let dir = cwd;
  for (;;) {
    const p = join(dir, fileName);
    if (existsSync(p)) {
      const uuid = readFileSync(p, 'utf8').trim();
      if (uuid) return { uuid, path: p };
    }
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
