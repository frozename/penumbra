import { Database } from 'bun:sqlite';

export function retireNonDirectMemory(db: Database, memoryId: string, now: number): boolean {
  const result = db.prepare(
    `UPDATE t2_memories SET retired_at = ? WHERE memory_id = ? AND retired_at IS NULL AND (origin IS NULL OR origin != 'direct')`,
  ).run(now, memoryId);
  return result.changes > 0;
}

export const retireMemory = retireNonDirectMemory;
