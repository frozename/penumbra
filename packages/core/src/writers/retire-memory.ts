import { Database } from "bun:sqlite";

function hasColumnName(column: unknown): column is { name: string } {
  return (
    typeof column === "object" &&
    column !== null &&
    "name" in column &&
    typeof (column as { name?: unknown }).name === "string"
  );
}

export function retireNonDirectMemory(db: Database, memoryId: string, now: number): boolean {
  const hasOrigin = db
    .prepare(`PRAGMA table_info(t2_memories)`)
    .all()
    .some((column) => hasColumnName(column) && column.name === "origin");

  const sql = hasOrigin
    ? `UPDATE t2_memories
       SET retired_at = ?
       WHERE memory_id = ?
         AND retired_at IS NULL
         AND (origin IS NULL OR origin != 'direct')`
    : `UPDATE t2_memories
       SET retired_at = ?
       WHERE memory_id = ?
         AND retired_at IS NULL`;

  const result = db.prepare(sql).run(now, memoryId);
  return result.changes > 0;
}

export const retireMemory = retireNonDirectMemory;
