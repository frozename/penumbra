import { dirname } from "node:path";
import { resolveProjectId } from "./project-id.js";
import { findProjectIdByCwd } from "../projects/registry-cwd.js";

export type ProjectScope =
  | { kind: "registered"; project_id: string; repo_root: string }
  | { kind: "no_match"; project_id: string; repo_root: string }
  | { kind: "registry_unavailable"; project_id: string; repo_root: string }
  | { kind: "global"; project_id: null; repo_root: null };

type ProjectRegistryLike = {
  list: () => Array<{ readonly project_id: string; readonly root_path: string }>;
};

type ResolveProjectScopeOpts = {
  cwd: string;
  registry?: ProjectRegistryLike;
};

export function resolveProjectScope(opts: ResolveProjectScopeOpts): ProjectScope {
  const resolved = resolveProjectId({ cwd: opts.cwd });
  if (resolved.kind === "quarantine") {
    return { kind: "global", project_id: null, repo_root: null };
  }

  const repoRoot =
    resolved.kind === "git"
      ? resolved.repo_root
      : dirname(resolved.kind === "marker" ? resolved.marker_path : opts.cwd);

  if (!opts.registry) {
    return { kind: "no_match", project_id: resolved.project_id, repo_root: repoRoot };
  }
  try {
    const entry = findProjectIdByCwd(
      opts.registry as Parameters<typeof findProjectIdByCwd>[0],
      opts.cwd,
    );
    if (entry) return { kind: "registered", project_id: entry, repo_root: repoRoot };
  } catch {
    return { kind: "registry_unavailable", project_id: resolved.project_id, repo_root: repoRoot };
  }
  return { kind: "no_match", project_id: resolved.project_id, repo_root: repoRoot };
}
