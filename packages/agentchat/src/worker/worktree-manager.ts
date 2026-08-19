import { defaultProjectRegistryPath, loadProjectRegistry, WorktreeManager } from "@penumbra/core";

export function createWorkerWorktreeManager(options?: {
  rootDir?: string;
  mainRepoDir?: string;
  resolveBranchName?: (handoff_id: string) => string | null | undefined;
}): WorktreeManager {
  let projectRegistry: ReturnType<typeof loadProjectRegistry> | undefined;
  try {
    const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
    projectRegistry = loadProjectRegistry(projectRegistryPath);
  } catch (err) {
    console.warn(
      `agentchat-worker: failed to load project registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const shouldResolveProjectRoot =
    projectRegistry !== undefined && projectRegistry.list().length > 0;

  return new WorktreeManager({
    rootDir: options?.rootDir,
    mainRepoDir: options?.mainRepoDir,
    resolveProjectRoot: shouldResolveProjectRoot
      ? (project_id: string): string | undefined => projectRegistry?.get(project_id)?.root_path
      : undefined,
    resolveBranchName: options?.resolveBranchName,
  });
}
