import type { FilterContrib } from "./index.js";
export function projectFilter(
  projectId: string | null | undefined,
  col = "project_id",
): FilterContrib | null {
  if (projectId === undefined) return null;
  return projectId === null
    ? { sql: `${col} IS NULL`, params: [] }
    : { sql: `${col} = ?`, params: [projectId] };
}
