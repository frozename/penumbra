export interface ProjectRegistryLike {
  get(project_id: string): { root_path: string } | undefined;
}

export class UnknownProjectError extends Error {
  readonly code = "unknown_project" as const;

  constructor(public readonly project_id: string) {
    super(`unknown project_id: ${project_id}`);
    this.name = "UnknownProjectError";
  }
}

export function resolveDispatchCwd(input: {
  project_id?: string | null;
  defaultCwd: string;
  projectRegistry?: ProjectRegistryLike;
}): string {
  if (!input.project_id) return input.defaultCwd;

  const entry = input.projectRegistry?.get(input.project_id);
  if (!entry) throw new UnknownProjectError(input.project_id);
  return entry.root_path;
}
