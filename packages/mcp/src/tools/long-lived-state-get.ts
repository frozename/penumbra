import type { Database } from "bun:sqlite";

import { WorkingMemorySchema } from "@penumbra/core/long-lived/types";
import { z } from "zod";

export const LongLivedStateGetArgsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export function handleLongLivedStateGet(
  db: Database,
  args: unknown,
): { working_memory: z.infer<typeof WorkingMemorySchema> } {
  const parsed = LongLivedStateGetArgsSchema.parse(args ?? {});
  const row = db
    .query<
      { working_memory_json: string },
      [string]
    >("SELECT working_memory_json FROM long_lived_agents WHERE id = ?")
    .get(parsed.id);
  if (!row) throw new Error("agent_not_found");
  return {
    working_memory: WorkingMemorySchema.parse(JSON.parse(row.working_memory_json)),
  };
}
