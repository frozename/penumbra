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
    'SELECT phase, action_type, status, target_ids, payload_json, decided_at FROM dream_actions WHERE action_id = ?'
  ).get(actionId) as {
    phase: string;
    action_type: string;
    status: string;
    target_ids: string;
    payload_json: string;
    decided_at: number;
  } | null;

  if (!action) throw new Error('Action not found: ' + actionId);

  const deps = db.prepare(
    'SELECT action_id FROM dream_actions WHERE payload_json LIKE ? AND status="auto_applied" AND reverted_by IS NULL'
  ).all('%"source_action_id":"' + actionId + '"%') as { action_id: string }[];

  if (deps.length > 0) {
    const ids = deps.map(d => d.action_id);
    if (cascade === 'none') {
      throw new Error('has_dependents: ' + ids.join(','));
    } else if (cascade === 'force') {
      for (const depId of ids) {
        revertDreamAction(db, depId, 'force');
      }
    }
  }

  if (action.phase === 'P7') {
    const targetIds = JSON.parse(action.target_ids) as string[];
    if (targetIds.length !== 1) throw new Error('Expected exactly 1 target memory for P7 action, got ' + targetIds.length);

    const memoryId = targetIds[0] as string;

    const snapshot = db.prepare(
      'SELECT embedding, embedding_model_version FROM t2_vec_history ' +
      'WHERE memory_id = ? AND snapshotted_at <= ? ' +
      'ORDER BY snapshotted_at DESC LIMIT 1'
    ).get(memoryId, action.decided_at || Date.now()) as { embedding: Uint8Array; embedding_model_version: string } | null;

    if (!snapshot) throw new Error('No vector snapshot found for memory ' + memoryId + ' before action ' + actionId);

    db.transaction(() => {
      db.prepare(
        'UPDATE t2_vec SET embedding = ? WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)'
      ).run(snapshot.embedding, memoryId);

      db.prepare(
        'UPDATE t2_memories SET embedding_model_version = ? WHERE memory_id = ?'
      ).run(snapshot.embedding_model_version === 'unknown' ? null : snapshot.embedding_model_version, memoryId);

      db.prepare(
        'UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?'
      ).run(actionId);
    })();
  } else if (action.phase === 'P1' && action.action_type === 'promote_t1' && action.status === 'auto_applied') {
    const targetIds = JSON.parse(action.target_ids) as string[];
    const rollupId = targetIds[0] as string;
    const payload = JSON.parse(action.payload_json ?? '{}') as { t2_memory_id?: string };

    let t2MemoryId = payload.t2_memory_id;
    if (!t2MemoryId) {
      // Fallback: match t2 row body against rollup's first_prompt_excerpt
      const rollup = db.prepare(
        'SELECT first_prompt_excerpt FROM t1_rollups WHERE rollup_id = ?'
      ).get(rollupId) as { first_prompt_excerpt: string | null } | null;
      if (rollup?.first_prompt_excerpt) {
        const t2Row = db.prepare(
          'SELECT memory_id FROM t2_memories WHERE body = ? LIMIT 1'
        ).get(rollup.first_prompt_excerpt) as { memory_id: string } | null;
        t2MemoryId = t2Row?.memory_id;
      }
    }

    db.transaction(() => {
      db.prepare('UPDATE t1_rollups SET t2_promoted_at = NULL WHERE rollup_id = ?').run(rollupId);
      if (t2MemoryId) {
        db.prepare('UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?').run(Date.now(), t2MemoryId);
      }
      db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
    })();
  } else if (action.phase === 'P2' && action.action_type === 'link' && action.status === 'auto_applied') {
    const targetIds = JSON.parse(action.target_ids) as string[];
    const srcId = targetIds[0] as string;
    const dstId = targetIds[1] as string;
    const payload = JSON.parse(action.payload_json ?? '{}') as { link_type?: string };
    const linkType = payload.link_type ?? 'semantic_near';

    db.transaction(() => {
      db.prepare(
        'UPDATE memory_links SET retired_at = ? WHERE src_id = ? AND dst_id = ? AND link_type = ?'
      ).run(Date.now(), srcId, dstId, linkType);
      db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
    })();
  } else if (action.phase === 'P3' && action.action_type === 'retire' && action.status === 'auto_applied') {
    const targetIds = JSON.parse(action.target_ids) as string[];
    const memoryId = targetIds[0] as string;

    db.transaction(() => {
      db.prepare('UPDATE t2_memories SET retired_at = NULL WHERE memory_id = ?').run(memoryId);
      db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
    })();
  } else if (action.phase === 'P6') {
    const targetIds = JSON.parse(action.target_ids) as string[];
    const projectId = targetIds[0] as string;

    db.transaction(() => {
      db.prepare('DELETE FROM project_briefs WHERE project_id = ?').run(projectId);
      db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
    })();
  } else {
    // Soft stamp — queued actions and unknown phases: no state rollback
    db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
  }
}
