import type { Database } from 'bun:sqlite';
import type { DreamConfig } from '../config.js';
import { detectT2Ephemera } from './t2-ephemera-detector.js';

export async function runPC1Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  _deps: object,
): Promise<void> {
  const batchSize = config.pc1BatchSize ?? 100;

  const patternRows = db
    .prepare(`SELECT pattern FROM curator_ephemera_patterns WHERE status='approved' AND enabled=1`)
    .all() as Array<{ pattern: string }>;
  const runtimePatterns = patternRows.map((r) => r.pattern);

  const memories = db
    .prepare(`SELECT memory_id, title, body, kind FROM t2_memories WHERE retired_at IS NULL LIMIT ?`)
    .all(batchSize) as Array<{ memory_id: string; title: string; body: string; kind: string }>;

  for (const mem of memories) {
    const verdict = detectT2Ephemera(mem, runtimePatterns);
    if (!verdict.isEphemera) continue;

    const existing = db
      .prepare(
        `SELECT 1 FROM dream_actions WHERE action_type='ephemera_retire' AND target_ids=? AND reverted_by IS NULL LIMIT 1`,
      )
      .get(JSON.stringify([mem.memory_id]));
    if (existing) continue;

    db.transaction(() => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES(?, ?, 'PC1', 'ephemera_retire', ?, 'auto_applied', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        cycleId,
        verdict.confidence ?? 0.99,
        JSON.stringify([mem.memory_id]),
        JSON.stringify({ reason: verdict.reason, confidence: verdict.confidence }),
      );
      db.prepare(`UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?`).run(now, mem.memory_id);
      // t2_fts is updated automatically via the t2_fts_update trigger on t2_memories
    })();
  }
}
