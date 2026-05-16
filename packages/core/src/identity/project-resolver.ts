import { resolveProjectId } from './project-id.js';

type ProjectRegistryLike = {
  list: () => Array<{
    project_id: string;
    root_path: string;
  }>;
};

export type ProjectScope =
  | { kind: 'registered'; project_id: string; repo_root: string }
  | { kind: 'synthetic'; project_id: string; repo_root: string }
  | { kind: 'global'; project_id: null; repo_root: null };

type ResolveProjectScopeOpts = {
  cwd: string;
  registry?: ProjectRegistryLike;
};

export function resolveProjectScope(opts: ResolveProjectScopeOpts): ProjectScope {
  const resolved = resolveProjectId({ cwd: opts.cwd });
  if (resolved.kind === 'quarantine') {
    return { kind: 'global', project_id: null, repo_root: null };
  }

  const repoRoot = resolved.kind === 'git' ? resolved.repo_root : opts.cwd;

  const synthetic: ProjectScope = {
    kind: 'synthetic',
    project_id: resolved.project_id,
    repo_root: repoRoot,
  };

  if (!opts.registry) return synthetic;

  let entries: Array<{ project_id: string; root_path: string }> = [];
  try {
    entries = opts.registry.list();
  } catch {
    return synthetic;
  }

  for (const entry of entries) {
    if (entry.root_path === repoRoot) {
      return { kind: 'registered', project_id: entry.project_id, repo_root: repoRoot };
    }
  }
  return synthetic;
}
