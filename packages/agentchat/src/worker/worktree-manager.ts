import { WorktreeManager } from "@penumbra/core";

import type { WorkerProjectRegistry } from "./project-registry.js";

export function createWorkerWorktreeManager(options: {
  rootDir?: string;
  mainRepoDir?: string;
  resolveBranchName?: (handoff_id: string) => string | null | undefined;
  projectRegistry: WorkerProjectRegistry;
}): WorktreeManager {
  const { projectRegistry } = options;

  return new WorktreeManager({
    rootDir: options.rootDir,
    mainRepoDir: options.mainRepoDir,
    // Lookup goes through the registry per call so a post-construction reload
    // (agentchat_reload) is visible without rebuilding the manager. An empty
    // registry means no project mapping is configured: resolveProjectRoot
    // reports unresolved and the unknown_project_id guard is disabled, so
    // every consumer falls through to the default root as if no registry
    // existed at all.
    resolveProjectRoot: (project_id: string): string | undefined =>
      projectRegistry.size === 0 ? undefined : projectRegistry.get(project_id)?.root_path,
    requireKnownProjectId: () => projectRegistry.size > 0,
    resolveBranchName: options.resolveBranchName,
  });
}
