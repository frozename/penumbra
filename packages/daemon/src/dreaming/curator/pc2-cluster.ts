import type { Database } from "bun:sqlite";
import { retireNonDirectMemory } from '@penumbra/core';
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
    const memberRows = db.prepare(`
      SELECT memory_id, retired_at
      FROM t2_memories
      WHERE memory_id IN (${placeholders})
      ORDER BY created_at DESC
    `).all(...cluster) as Array<{ memory_id: string; retired_at: number | null }>;

    const canonical = memberRows.find((row) => row.retired_at === null);
    if (!canonical) continue;
    const canonicalId = canonical.memory_id;
    const retiredMap = new Map(memberRows.map((row) => [row.memory_id, row.retired_at]));

    // F2: MAX(weight) scoped to intra-cluster edges only (both endpoints in cluster)
    const maxSimRow = db.prepare(`
      SELECT MAX(weight) AS max_w FROM memory_links
       WHERE link_type='semantic_near'
       AND retired_at IS NULL
       AND src_id IN (${placeholders})
       AND dst_id IN (${placeholders})
    `).get(...cluster, ...cluster) as { max_w: number | null };

    const maxSimilarity = maxSimRow.max_w ?? 0;
    const shouldAutoApply =
      process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY === '1' && maxSimilarity >= autoThreshold;
    const status = shouldAutoApply ? "auto_applied" : "queued";

    const existingActionRows = db.prepare(`
      SELECT target_ids
      FROM dream_actions
      WHERE action_type='cluster_retire'
        AND status IN ('queued', 'auto_applied')
        AND reverted_by IS NULL
        AND target_ids IN (${cluster.map((id) => '?').join(',')})
    `).all(...cluster.map((id) => JSON.stringify([id]))) as Array<{ target_ids: string }>;
    const existingSet = new Set(existingActionRows.map((row) => row.target_ids));

    db.transaction(() => {
      for (const memoryId of cluster) {
        if (memoryId === canonicalId) continue;

        // F11: skip already-retired members
        // Skip if existing non-reverted cluster_retire action targets it
        const targetIdsStr = JSON.stringify([memoryId]);
        if (existingSet.has(targetIdsStr)) continue;
        if (retiredMap.get(memoryId) !== null) continue;

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

        if (status === 'auto_applied' && !retireNonDirectMemory(db, memoryId, Date.now())) {
          db.prepare(`
            UPDATE dream_actions
            SET status = 'skipped_direct_origin'
            WHERE action_id = ?
          `).run(actionId);
        }
      }
    })();
  }
}
