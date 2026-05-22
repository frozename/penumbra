import type { Database } from "bun:sqlite";
import type { DreamConfig } from "../config.js";
import { findSimilarityClusters } from "./cluster-detection.js";

export async function runPC2Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: {}
): Promise<void> {
  const minSize = config.pc2MinClusterSize ?? 3;
  const minWeight = config.pc2QueueThreshold ?? 0.85;
  const autoThreshold = config.pc2AutoThreshold ?? 2.0;

  const clusters = findSimilarityClusters(db, { minSize, minWeight });

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;

    const placeholders = cluster.map(() => "?").join(",");
    
    // Fallback: recall_count doesn't exist on t2_memories yet, using only created_at DESC
    const canonicalRow = db.prepare(`
      SELECT memory_id 
      FROM t2_memories 
      WHERE memory_id IN (${placeholders}) AND retired_at IS NULL 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(...cluster) as { memory_id: string } | undefined;

    if (!canonicalRow) continue;
    const canonicalId = canonicalRow.memory_id;

    const maxSimRow = db.prepare(`
      SELECT MAX(weight) as maxWeight 
      FROM memory_links 
      WHERE (src_id IN (${placeholders}) OR dst_id IN (${placeholders})) 
        AND src_id != dst_id 
        AND link_type='semantic_near'
    `).get(...cluster, ...cluster) as { maxWeight: number | null };

    const maxSimilarity = maxSimRow.maxWeight ?? 0;
    const status = maxSimilarity >= autoThreshold ? "auto_applied" : "queued";

    db.transaction(() => {
      for (const memoryId of cluster) {
        if (memoryId === canonicalId) continue;

        // Skip if existing non-reverted cluster_retire action targets it
        const targetIdsStr = JSON.stringify([memoryId]);
        const existing = db.prepare(`
          SELECT 1 
          FROM dream_actions 
          WHERE action_type='cluster_retire' AND target_ids = ? AND reverted_by IS NULL 
          LIMIT 1
        `).get(targetIdsStr);

        if (existing) continue;

        const actionId = crypto.randomUUID();
        const payloadJson = JSON.stringify({
          canonical_id: canonicalId,
          similarity: maxSimilarity,
          cluster_size: cluster.length
        });

        db.prepare(`
          INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
          VALUES(?, ?, 'PC2', 'cluster_retire', 1.0, ?, ?, ?)
        `).run(actionId, cycleId, status, targetIdsStr, payloadJson);

        if (status === "auto_applied") {
          db.prepare(`UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?`).run(Date.now(), memoryId);
        }
      }
    })();
  }
}
