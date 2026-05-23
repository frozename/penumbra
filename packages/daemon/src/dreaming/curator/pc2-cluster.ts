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
  const minWeight = config.pc2ClusterLinkThreshold ?? 0.85;
  const autoThreshold = config.pc2AutoThreshold ?? 0.97;

  const clusters = findSimilarityClusters(db, { minSize, minWeight });

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;

    const placeholders = cluster.map(() => "?").join(",");

    const canonicalRow = db.prepare(`
      SELECT memory_id
      FROM t2_memories
      WHERE memory_id IN (${placeholders}) AND retired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(...cluster) as { memory_id: string } | undefined;

    if (!canonicalRow) continue;
    const canonicalId = canonicalRow.memory_id;

    // F2: MAX(weight) scoped to intra-cluster edges only (both endpoints in cluster)
    const maxSimRow = db.prepare(`
      SELECT MAX(weight) AS max_w FROM memory_links
       WHERE link_type='semantic_near'
         AND retired_at IS NULL
         AND src_id IN (${placeholders})
         AND dst_id IN (${placeholders})
    `).get(...cluster, ...cluster) as { max_w: number | null };

    const maxSimilarity = maxSimRow.max_w ?? 0;
    const status = maxSimilarity >= autoThreshold ? "auto_applied" : "queued";

    db.transaction(() => {
      for (const memoryId of cluster) {
        if (memoryId === canonicalId) continue;

        // F11: skip already-retired members
        const memStatus = db.prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`).get(memoryId) as any;
        if (memStatus?.retired_at) continue;

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
