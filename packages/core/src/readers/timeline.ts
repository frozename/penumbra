import type { Database } from "bun:sqlite";

import {
  computeAgeDays,
  staleThresholdDays,
  type TimelineEntry,
  type TimelineRequest,
} from "../schemas/recall.js";

/**
 * Returns chronological neighbors around an anchor t2 memory. Useful as the
 * second hop of the search → timeline → get_observations workflow.
 */
export function timeline(db: Database, req: TimelineRequest): TimelineEntry[] {
  const now = req.now?.getTime() ?? Date.now();
  const anchor = db
    .query<{ created_at: string; project_id: string | null; obs_type: string | null }, [string]>(
      `SELECT created_at, project_id, obs_type
         FROM t2_memories
        WHERE memory_id = ?
          AND retired_at IS NULL`,
    )
    .get(req.anchor);
  if (!anchor) return [];

  const projectId = req.project_id ?? null;
  const useProjectFilter = projectId !== null;
  const projectFragment = useProjectFilter ? "AND project_id = ?" : "";

  const beforeRows = db
    .query<
      {
        id: string;
        ts: string;
        obs_type: string | null;
        title: string;
        created_at_raw: string;
        last_verified_at: string | null;
      },
      (string | number | null)[]
    >(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title,
              created_at AS created_at_raw, last_verified_at
         FROM t2_memories
        WHERE created_at < ?
          AND retired_at IS NULL
          ${projectFragment}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(
      ...(useProjectFilter
        ? [anchor.created_at, projectId, req.depth_before]
        : [anchor.created_at, req.depth_before]),
    )
    .reverse();

  const anchorRow = db
    .query<
      {
        id: string;
        ts: string;
        obs_type: string | null;
        title: string;
        created_at_raw: string;
        last_verified_at: string | null;
      },
      [string]
    >(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title,
              created_at AS created_at_raw, last_verified_at
         FROM t2_memories
        WHERE memory_id = ?
          AND retired_at IS NULL`,
    )
    .get(req.anchor);

  const afterRows = db
    .query<
      {
        id: string;
        ts: string;
        obs_type: string | null;
        title: string;
        created_at_raw: string;
        last_verified_at: string | null;
      },
      (string | number | null)[]
    >(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title,
              created_at AS created_at_raw, last_verified_at
         FROM t2_memories
        WHERE created_at > ?
          AND retired_at IS NULL
          ${projectFragment}
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(
      ...(useProjectFilter
        ? [anchor.created_at, projectId, req.depth_after]
        : [anchor.created_at, req.depth_after]),
    );

  return [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows].map((row) => {
    const ageDays = computeAgeDays(now, row.created_at_raw, row.last_verified_at);
    return {
      id: row.id,
      ts: row.ts,
      obs_type: row.obs_type,
      title: row.title,
      age_days: ageDays ?? undefined,
      stale: ageDays === null ? true : ageDays >= staleThresholdDays(row.obs_type),
    };
  });
}
