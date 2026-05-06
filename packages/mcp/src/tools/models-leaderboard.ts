import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toTextContent } from '@nova/mcp-shared';
import { queryRows } from '../../../eval/src/store/sqlite.ts';

import { z } from 'zod';

export const ModelsLeaderboardInputSchema = z.object({
  node: z.string().min(1).optional(),
  min_throughput: z.number().positive().optional(),
  min_tool_call_score: z.number().min(0).max(1).optional(),
  sort_by: z.enum(['throughput_tps', 'tool_call_score', 'context_8k_score', 'context_16k_score', 'json_score', 'composite_score']).optional(),
});

export const ModelsLeaderboardInputShape = ModelsLeaderboardInputSchema.shape;

function resolveEvalDb(): string {
  const root = process.env.DEV_STORAGE ?? process.env.PENUMBRA_STORAGE_ROOT;
  if (!root) return '';
  return join(root, 'eval', 'leaderboard.sqlite');
}

export function modelsLeaderboardHandler() {
  return async (input: unknown) => {
    const parsed = ModelsLeaderboardInputSchema.parse(input ?? {});
    const dbPath = resolveEvalDb();
    if (!dbPath || !existsSync(dbPath)) return toTextContent([]);
    const db = new Database(dbPath);
    try {
      return toTextContent(queryRows(db, parsed));
    } finally {
      db.close();
    }
  };
}
