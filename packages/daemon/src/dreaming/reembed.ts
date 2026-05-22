import type { Database } from 'bun:sqlite';
import type { DreamConfig } from './config.js';
import type { DreamCycleDeps } from './cycle.js';

export async function runReembedPhase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: DreamCycleDeps
): Promise<void> {
  if (!deps.onReembed) return;

  const currentModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION || 'v1';
  
  const staleMemories = db.prepare(
    `SELECT memory_id, body, embedding_model_version 
     FROM t2_memories 
     WHERE embedding_model_version IS NULL OR embedding_model_version != ?
     LIMIT ?`
  ).all(currentModelVersion, config.reembedBatchSize) as Array<{
    memory_id: string;
    body: string;
    embedding_model_version: string | null;
  }>;


  if (staleMemories.length === 0) return;

  for (const mem of staleMemories) {
    const vecRow = db.prepare(
      `SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`
    ).get(mem.memory_id) as { embedding: Uint8Array } | null;

    if (vecRow?.embedding) {
      db.prepare(
        `INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at, snapshotted_by_cycle)
         VALUES(?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        mem.memory_id,
        vecRow.embedding,
        mem.embedding_model_version || 'unknown',
        Date.now(),
        cycleId
      );
    }

    try {
      const newVec = await deps.onReembed(mem.memory_id, mem.body);
      const newVecBuffer = Buffer.from(newVec.buffer, newVec.byteOffset, newVec.byteLength);

      db.transaction(() => {
        db.prepare(
          `UPDATE t2_vec SET embedding = ? WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`
        ).run(newVecBuffer, mem.memory_id);

        db.prepare(
          `UPDATE t2_memories SET embedding_model_version = ? WHERE memory_id = ?`
        ).run(currentModelVersion, mem.memory_id);

        db.prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P7', 'reembed', 1.0, 'auto_applied', ?, ?)`
        ).run(
          crypto.randomUUID(),
          cycleId,
          JSON.stringify([mem.memory_id]),
          JSON.stringify({ previous_version: mem.embedding_model_version })
        );
      })();
    } catch (err) {
      console.error(`error: P7 reembed failed for memory ${mem.memory_id}:`, err);
    }
  }
}

export function revertDreamAction(db: Database, actionId: string, cascade: 'none' | 'force' = 'none'): void {
  const action = db.prepare(
    `SELECT phase, target_ids, decided_at FROM dream_actions WHERE action_id = ?`
  ).get(actionId) as { phase: string; target_ids: string; decided_at: number } | null;

  if (!action) throw new Error(`Action not found: ${actionId}`);
  if (action.phase !== 'P7') throw new Error(`Only P7 revert is currently supported`);

  const targetIds = JSON.parse(action.target_ids) as string[];
  if (targetIds.length !== 1) throw new Error(`Expected exactly 1 target memory for P7 action, got ${targetIds.length}`);

  const memoryId = targetIds[0] as string;

  const snapshot = db.prepare(
    `SELECT embedding, embedding_model_version FROM t2_vec_history 
     WHERE memory_id = ? AND snapshotted_at <= ?
     ORDER BY snapshotted_at DESC LIMIT 1`
  ).get(memoryId, action.decided_at || Date.now()) as { embedding: Uint8Array; embedding_model_version: string } | null;

  if (!snapshot) throw new Error(`No vector snapshot found for memory ${memoryId} before action ${actionId}`);

  db.transaction(() => {
    db.prepare(
      `UPDATE t2_vec SET embedding = ? WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`
    ).run(snapshot.embedding, memoryId);

    db.prepare(
      `UPDATE t2_memories SET embedding_model_version = ? WHERE memory_id = ?`
    ).run(snapshot.embedding_model_version === 'unknown' ? null : snapshot.embedding_model_version, memoryId);

    db.prepare(
      `UPDATE dream_actions SET reverted_by = 'maestro-cli' WHERE action_id = ?`
    ).run(actionId);
  })();
}
