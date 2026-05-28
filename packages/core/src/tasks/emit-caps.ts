import type { Database } from "bun:sqlite";
import type { FileTaskInput } from "./schema.js";

const DEFAULT_MAX_DESCENDANTS_PER_ROOT = 20;
const DEFAULT_MAX_EMIT_DEPTH = 5;
const DEFAULT_PER_AGENT_WINDOW_MS = 600_000;
const DEFAULT_PER_AGENT_MAX = 10;

export type EmitCapScope = "depth" | "descendants" | "rate";

export class EmitCapExceeded extends Error {
  constructor(
    public readonly scope: EmitCapScope,
    public readonly limit: number,
    public readonly observed: number,
  ) {
    super(`emit cap exceeded: scope=${scope} limit=${limit} observed=${observed}`);
    this.name = "EmitCapExceeded";
  }
}

export interface EnforceEmitCapsOpts {
  producer_kind: FileTaskInput["created_by_kind"];
  producer_id: string;
  parent_task_id?: string;
  max_descendants_per_root?: number;
  max_emit_depth?: number;
  per_agent_window_ms?: number;
  per_agent_max?: number;
  now?: () => number;
}

export function enforceEmitCaps(db: Database, opts: EnforceEmitCapsOpts): void {
  if (opts.producer_kind !== "agent") return;

  const maxDescendantsPerRoot = opts.max_descendants_per_root ?? DEFAULT_MAX_DESCENDANTS_PER_ROOT;
  const maxEmitDepth = opts.max_emit_depth ?? DEFAULT_MAX_EMIT_DEPTH;
  const perAgentWindowMs = opts.per_agent_window_ms ?? DEFAULT_PER_AGENT_WINDOW_MS;
  const perAgentMax = opts.per_agent_max ?? DEFAULT_PER_AGENT_MAX;
  const nowFn = opts.now ?? Date.now;

  if (opts.parent_task_id) {
    const chain = resolveRootAndDepth(db, opts.parent_task_id);
    if (chain.newTaskDepth > maxEmitDepth) {
      throw new EmitCapExceeded("depth", maxEmitDepth, chain.newTaskDepth);
    }

    const descendantsCount = countDescendants(db, chain.rootTaskId);
    if (descendantsCount >= maxDescendantsPerRoot) {
      throw new EmitCapExceeded("descendants", maxDescendantsPerRoot, descendantsCount);
    }
  }

  const windowStart = nowFn() - perAgentWindowMs;
  const rateCount =
    db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n
       FROM tasks
       WHERE created_by_kind = 'agent'
         AND created_by_id = ?
         AND created_at >= ?`,
      )
      .get(opts.producer_id, windowStart)?.n ?? 0;

  if (rateCount >= perAgentMax) {
    throw new EmitCapExceeded("rate", perAgentMax, rateCount);
  }
}

function resolveRootAndDepth(
  db: Database,
  parentTaskId: string,
): { rootTaskId: string; newTaskDepth: number } {
  let cursor = parentTaskId;
  let newTaskDepth = 1;

  while (true) {
    const row = db
      .query<
        { parent_task_id: string | null },
        [string]
      >(`SELECT parent_task_id FROM tasks WHERE id = ?`)
      .get(cursor);

    if (!row || row.parent_task_id === null) {
      return { rootTaskId: cursor, newTaskDepth };
    }

    cursor = row.parent_task_id;
    newTaskDepth += 1;
  }
}

function countDescendants(db: Database, rootTaskId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM tasks WHERE parent_task_id = ?
         UNION ALL
         SELECT t.id
         FROM tasks t
         INNER JOIN descendants d ON t.parent_task_id = d.id
       )
       SELECT COUNT(*) AS n FROM descendants`,
    )
    .get(rootTaskId);

  return row?.n ?? 0;
}
