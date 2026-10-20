import type { Database } from "bun:sqlite";

import { buildT2EmbedText, retireNonDirectMemory } from "@penumbra/core";

import type { DreamConfig } from "./config.js";
import type { DreamCycleDeps } from "./cycle.js";

function isTrueEnv(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value === "true" || value === "yes";
}

export async function runReembedPhase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: DreamCycleDeps,
): Promise<{ deferred: boolean; processed: number }> {
  if (!isTrueEnv(process.env.PENUMBRA_T2_REEMBED_ENABLED)) return { deferred: false, processed: 0 };
  if (!deps.onReembed) return { deferred: false, processed: 0 };

  const currentModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION ?? "v1";

  const staleMemories = db
    .prepare(
      `SELECT memory_id, title, body, embedding_model_version
       FROM t2_memories
       WHERE embedding_model_version IS NULL OR embedding_model_version != ?
       LIMIT ?`,
    )
    .all(currentModelVersion, config.reembedBatchSize) as {
    memory_id: string;
    title: string;
    body: string;
    embedding_model_version: string | null;
  }[];

  if (staleMemories.length === 0) return { deferred: false, processed: 0 };

  let processed = 0;

  for (const mem of staleMemories) {
    const vecRow = db
      .prepare(
        `SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`,
      )
      .get(mem.memory_id) as { embedding: Uint8Array } | null;

    if (vecRow?.embedding) {
      db.prepare(
        `INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at, snapshotted_by_cycle)
         VALUES(?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        mem.memory_id,
        vecRow.embedding,
        mem.embedding_model_version ?? "unknown",
        Date.now(),
        cycleId,
      );
    }

    try {
      const embedText = buildT2EmbedText(mem.title, mem.body);
      const newVec = await deps.onReembed(mem.memory_id, embedText);
      const newVecBuffer = Buffer.from(newVec.buffer, newVec.byteOffset, newVec.byteLength);

      db.transaction(() => {
        const row = db
          .prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`)
          .get(mem.memory_id) as { rowid: number } | null;
        if (!row) {
          throw new Error(`P7 reembed target missing rowid for memory ${mem.memory_id}`);
        }

        try {
          db.prepare(`INSERT OR REPLACE INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(
            row.rowid,
            newVecBuffer,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/UNIQUE constraint failed/i.test(msg)) throw err;
          db.prepare(`DELETE FROM t2_vec WHERE rowid = ?`).run(row.rowid);
          db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(
            row.rowid,
            newVecBuffer,
          );
        }

        db.prepare(`UPDATE t2_memories SET embedding_model_version = ? WHERE memory_id = ?`).run(
          currentModelVersion,
          mem.memory_id,
        );

        db.prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P7', 'reembed', 1.0, 'auto_applied', ?, ?)`,
        ).run(
          crypto.randomUUID(),
          cycleId,
          JSON.stringify([mem.memory_id]),
          JSON.stringify({ previous_version: mem.embedding_model_version }),
        );
      })();
      processed += 1;
    } catch (err) {
      console.error(`error: P7 reembed failed for memory ${mem.memory_id}:`, err);
    }
  }

  return { deferred: false, processed };
}

type DreamActionRow = {
  phase: string;
  action_type: string;
  status: string;
  target_ids: string;
  payload_json: string;
  decided_at: number | null;
  reverted_by: string | null;
};

class DreamActionApplyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getDreamAction(db: Database, actionId: string): DreamActionRow | null {
  return db
    .prepare(
      "SELECT phase, action_type, status, target_ids, payload_json, decided_at, reverted_by FROM dream_actions WHERE action_id = ?",
    )
    .get(actionId) as DreamActionRow | null;
}

function parseTargetIds(targetIdsRaw: string): string[] {
  const parsed = safeParseJson(targetIdsRaw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new DreamActionApplyError(
      "invalid_target_ids",
      "dream action target_ids must be string[]",
    );
  }
  return parsed;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseDreamActionPayload(raw: string | null, actionId: string): Record<string, unknown> {
  const parsed = safeParseJson(raw ?? "{}");
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new DreamActionApplyError(
    "invalid_payload_json",
    `dream action payload_json must be a JSON object: ${actionId}`,
    422,
  );
}

function markDreamActionReverted(db: Database, actionId: string, previousStatus: string): void {
  if (previousStatus === "applied") {
    db.prepare(
      'UPDATE dream_actions SET reverted_by = "user", status = "reverted" WHERE action_id = ?',
    ).run(actionId);
    return;
  }
  db.prepare('UPDATE dream_actions SET reverted_by = "user" WHERE action_id = ?').run(actionId);
}

export function applyDreamAction(db: Database, actionId: string): void {
  const action = getDreamAction(db, actionId);
  if (!action)
    throw new DreamActionApplyError("action_not_found", "Action not found: " + actionId, 404);
  if (action.status !== "queued") {
    throw new DreamActionApplyError(
      "action_not_queued",
      `Action must be queued before apply: ${actionId} (status=${action.status})`,
      409,
    );
  }

  const targetIds = parseTargetIds(action.target_ids);
  const now = Date.now();

  db.transaction(() => {
    if (action.action_type === "ephemera_retire" || action.action_type === "retire") {
      const memoryId = targetIds[0];
      if (!memoryId) {
        throw new DreamActionApplyError(
          "invalid_target_ids",
          `Action ${actionId} requires exactly one memory target`,
        );
      }
      const retired = retireNonDirectMemory(db, memoryId, now);
      if (!retired) {
        throw new DreamActionApplyError(
          "retire_not_applied",
          `Action ${actionId} did not retire target memory ${memoryId}`,
        );
      }
    } else if (action.action_type === "merge" || action.action_type === "promote_t1") {
      throw new DreamActionApplyError(
        "apply_not_supported",
        `Action type ${action.action_type} is not safely applyable yet`,
        422,
      );
    } else {
      throw new DreamActionApplyError(
        "unknown_action_type",
        `Unknown apply action_type: ${action.action_type}`,
        422,
      );
    }

    db.prepare(
      "UPDATE dream_actions SET status = 'applied', decided_at = ?, decided_by = 'user' WHERE action_id = ?",
    ).run(now, actionId);
  })();
}

function revertDependents(db: Database, actionId: string, cascade: "none" | "force"): void {
  const deps = db
    .prepare(
      'SELECT action_id FROM dream_actions WHERE payload_json LIKE ? AND status="auto_applied" AND reverted_by IS NULL',
    )
    .all('%"source_action_id":"' + actionId + '"%') as { action_id: string }[];

  if (deps.length === 0) return;

  const ids = deps.map((d) => d.action_id);
  if (cascade === "none") {
    throw new Error("has_dependents: " + ids.join(","));
  }
  for (const depId of ids) {
    revertDreamAction(db, depId, "force");
  }
}

function revertP7(db: Database, action: DreamActionRow, actionId: string): void {
  const targetIds = parseTargetIds(action.target_ids);
  const memoryId = targetIds[0];
  if (!memoryId) throw new Error("Expected exactly 1 target memory for P7 action");

  const snapshot = db
    .prepare(
      "SELECT embedding, embedding_model_version FROM t2_vec_history " +
        "WHERE memory_id = ? AND snapshotted_at <= ? " +
        "ORDER BY snapshotted_at DESC LIMIT 1",
    )
    .get(memoryId, action.decided_at ?? Date.now()) as {
    embedding: Uint8Array;
    embedding_model_version: string;
  } | null;

  if (!snapshot)
    throw new Error(
      "No vector snapshot found for memory " + memoryId + " before action " + actionId,
    );

  db.transaction(() => {
    db.prepare(
      "UPDATE t2_vec SET embedding = ? WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)",
    ).run(snapshot.embedding, memoryId);
    db.prepare("UPDATE t2_memories SET embedding_model_version = ? WHERE memory_id = ?").run(
      snapshot.embedding_model_version === "unknown" ? null : snapshot.embedding_model_version,
      memoryId,
    );
    markDreamActionReverted(db, actionId, action.status);
  })();
}

function revertP1(db: Database, action: DreamActionRow, actionId: string): void {
  const targetIds = parseTargetIds(action.target_ids);
  const rollupId = targetIds[0];
  if (!rollupId) throw new Error("P1 revert: missing rollup ID");

  const raw = parseDreamActionPayload(action.payload_json, actionId);
  const t2MemoryId = typeof raw.t2_memory_id === "string" ? raw.t2_memory_id : undefined;
  if (!t2MemoryId) throw new Error("p1_revert_missing_t2_memory_id");

  db.transaction(() => {
    // A revert is an operator verdict that the promotion was wrong; without the
    // permanent filter mark both claim paths re-select the rollup and the same
    // judges re-mint the same memory.
    db.prepare(
      "UPDATE t1_rollups SET t2_promoted_at = NULL, promotion_filtered_at = ? WHERE rollup_id = ?",
    ).run(new Date().toISOString(), rollupId);
    // P1 revert intentionally bypasses the direct-origin guard to restore the original
    // rollup artifact state even when the promoted target was direct.
    db.prepare("UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?").run(
      Date.now(),
      t2MemoryId,
    );
    markDreamActionReverted(db, actionId, action.status);
  })();
}

function revertP2(db: Database, action: DreamActionRow, actionId: string): void {
  const targetIds = parseTargetIds(action.target_ids);
  const srcId = targetIds[0];
  const dstId = targetIds[1];
  if (!srcId || !dstId) throw new Error("P2 revert: missing source or destination ID");

  const raw = parseDreamActionPayload(action.payload_json, actionId);
  const linkType = typeof raw.link_type === "string" ? raw.link_type : "semantic_near";

  db.transaction(() => {
    db.prepare(
      "UPDATE memory_links SET retired_at = ? WHERE src_id = ? AND dst_id = ? AND link_type = ?",
    ).run(Date.now(), srcId, dstId, linkType);
    markDreamActionReverted(db, actionId, action.status);
  })();
}

function revertMemoryRetire(db: Database, action: DreamActionRow, actionId: string): void {
  const targetIds = parseTargetIds(action.target_ids);
  const memoryId = targetIds[0];
  if (!memoryId) throw new Error("Revert retire: missing memory ID");

  db.transaction(() => {
    db.prepare("UPDATE t2_memories SET retired_at = NULL WHERE memory_id = ?").run(memoryId);
    markDreamActionReverted(db, actionId, action.status);
  })();
}

function revertP6(db: Database, action: DreamActionRow, actionId: string): void {
  const targetIds = parseTargetIds(action.target_ids);
  const projectId = targetIds[0];
  if (!projectId) throw new Error("P6 revert: missing project ID");

  db.transaction(() => {
    db.prepare("DELETE FROM project_briefs WHERE project_id = ? AND generated_at <= ?").run(
      projectId,
      action.decided_at,
    );
    markDreamActionReverted(db, actionId, action.status);
  })();
}

function applyPhaseRevert(db: Database, action: DreamActionRow, actionId: string): void {
  if (action.phase === "P7") {
    revertP7(db, action, actionId);
    return;
  }
  if (action.phase === "P1" && action.action_type === "promote_t1") {
    revertP1(db, action, actionId);
    return;
  }
  if (action.phase === "P2" && action.action_type === "link") {
    revertP2(db, action, actionId);
    return;
  }
  if (action.phase === "P3" && action.action_type === "retire") {
    revertMemoryRetire(db, action, actionId);
    return;
  }
  if (action.action_type === "ephemera_retire") {
    revertMemoryRetire(db, action, actionId);
    return;
  }
  if (action.action_type === "cluster_retire") {
    revertMemoryRetire(db, action, actionId);
    return;
  }
  if (action.phase === "P6") {
    revertP6(db, action, actionId);
    return;
  }
  markDreamActionReverted(db, actionId, action.status);
}

export function revertDreamAction(
  db: Database,
  actionId: string,
  cascade: "none" | "force" = "none",
): void {
  const action = getDreamAction(db, actionId);

  if (!action) throw new Error("Action not found: " + actionId);
  if (action.reverted_by !== null) return;

  revertDependents(db, actionId, cascade);

  const canCompensate = action.status === "auto_applied" || action.status === "applied";
  if (canCompensate) {
    applyPhaseRevert(db, action, actionId);
  } else {
    markDreamActionReverted(db, actionId, action.status);
  }
}
