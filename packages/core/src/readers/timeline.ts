import type { Database } from 'bun:sqlite';
import type { TimelineRequest, TimelineEntry } from '../schemas/recall.js';

/**
 * Returns chronological neighbors around an anchor t2 memory. Useful as the
 * second hop of the search → timeline → get_observations workflow.
 */
export function timeline(db: Database, req: TimelineRequest): TimelineEntry[] {
  const anchor = db
    .query<{ created_at: string; project_id: string | null }, [string]>(
      `SELECT created_at, project_id FROM t2_memories WHERE memory_id = ?`,
    )
    .get(req.anchor);
  if (!anchor) return [];

  const projectId = req.project_id ?? null;
  const useProjectFilter = projectId !== null;
  const projectFragment = useProjectFilter ? 'AND project_id = ?' : '';

  const beforeRows = db
    .query<TimelineEntry, (string | number | null)[]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title
         FROM t2_memories
        WHERE created_at < ? ${projectFragment}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(
      ...(useProjectFilter
        ? [anchor.created_at, projectId as string, req.depth_before]
        : [anchor.created_at, req.depth_before]),
    )
    .reverse();

  const anchorRow = db
    .query<TimelineEntry, [string]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title FROM t2_memories WHERE memory_id = ?`,
    )
    .get(req.anchor);

  const afterRows = db
    .query<TimelineEntry, (string | number | null)[]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title
         FROM t2_memories
        WHERE created_at > ? ${projectFragment}
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(
      ...(useProjectFilter
        ? [anchor.created_at, projectId as string, req.depth_after]
        : [anchor.created_at, req.depth_after]),
    );

  return [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows];
}
