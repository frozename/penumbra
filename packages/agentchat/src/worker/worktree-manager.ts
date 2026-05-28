import { defaultProjectRegistryPath, loadProjectRegistry, WorktreeManager } from "@penumbra/core";

export function createWorkerWorktreeManager(options?: { rootDir?: string; mainRepoDir?: string }) {
  let projectRegistry: ReturnType<typeof loadProjectRegistry> | undefined;
  try {
    const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
    projectRegistry = loadProjectRegistry(projectRegistryPath);
  } catch (err) {
    console.warn(`agentchat-worker: failed to load project registry: ${err}`);
  }

  const shouldResolveProjectRoot =
    projectRegistry !== undefined && projectRegistry.list().length > 0;

  return new WorktreeManager({
    rootDir: options?.rootDir,
    mainRepoDir: options?.mainRepoDir,
    resolveProjectRoot: shouldResolveProjectRoot
      ? (project_id: string) => projectRegistry?.get(project_id)?.root_path
      : undefined,
  });
}
