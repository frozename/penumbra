import type { Database } from "bun:sqlite";

import { retireNonDirectMemory } from "@penumbra/core";

import type { DreamConfig } from "../config.js";

import { detectT2Ephemera } from "./t2-ephemera-detector.js";

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function upsertCursor(db: Database, name: string, value: string): void {
  db.prepare(
    `INSERT INTO curator_cursors(name, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(name, value, Date.now());
}

function readCursor(db: Database): string {
  const cursorRow = db
    .prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`)
    .get() as { value: string } | undefined;
  return cursorRow?.value ?? "";
}

function pc1BatchSize(config: DreamConfig): number {
  return Number.isFinite(config.pc1BatchSize) && config.pc1BatchSize >= 0
    ? config.pc1BatchSize
    : 100;
}

export function runPC1Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  _deps: object,
): void {
  const autoRetireEnabled = isEnvTruthy(process.env.PENUMBRA_PC1_AUTORETIRE);
  const batchSize = pc1BatchSize(config);

  const patternRows = db
    .prepare(`SELECT pattern FROM curator_ephemera_patterns WHERE status='approved' AND enabled=1`)
    .all() as { pattern: string }[];
  const runtimePatterns = patternRows.map((r) => r.pattern);

  // F4: read cursor — default '' means start from beginning
  const cursor = readCursor(db);

  const memories = db
    .prepare(
      `SELECT memory_id, title, body, kind FROM t2_memories
       WHERE retired_at IS NULL AND memory_id > ?
       ORDER BY memory_id ASC LIMIT ?`,
    )
    .all(cursor, batchSize + 1) as {
    memory_id: string;
    title: string;
    body: string;
    kind: string;
  }[];
  const page = memories.slice(0, batchSize);

  for (const mem of page) {
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
      const actionId = crypto.randomUUID();
      const retired = autoRetireEnabled ? retireNonDirectMemory(db, mem.memory_id, now) : false;
      const status = autoRetireEnabled
        ? retired
          ? "auto_applied"
          : "skipped_direct_origin"
        : "queued";
      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES(?, ?, 'PC1', 'ephemera_retire', ?, ?, ?, ?)`,
      ).run(
        actionId,
        cycleId,
        verdict.confidence ?? 0.99,
        status,
        JSON.stringify([mem.memory_id]),
        JSON.stringify({ reason: verdict.reason, confidence: verdict.confidence }),
      );
    })();
  }

  // F4: advance cursor; wrap to '' when batch exhausted
  if (page.length === 0) {
    const currentCursor = readCursor(db);
    if (currentCursor !== "") {
      upsertCursor(db, "pc1_memory_id", "");
    }
    return;
  }

  const lastPage = page.at(-1);
  if (!lastPage) return;
  const lastId = lastPage.memory_id;
  const hasMore = memories.length > batchSize;
  upsertCursor(db, "pc1_memory_id", page.length < batchSize || !hasMore ? "" : lastId);
}
