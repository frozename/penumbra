import type { Database } from 'bun:sqlite';
import type { DreamConfig } from '../config.js';
import { detectT2Ephemera } from './t2-ephemera-detector.js';

function upsertCursor(db: Database, name: string, value: string): void {
  db.prepare(
    `INSERT INTO curator_cursors(name, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(name, value, Date.now());
}

export async function runPC1Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  _deps: object,
): Promise<void> {
  const batchSize = config.pc1BatchSize ?? 100;

  // Runtime fallback: ensure cursor table exists for daemons on older schemas
  db.exec(`CREATE TABLE IF NOT EXISTS curator_cursors (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  const patternRows = db
    .prepare(`SELECT pattern FROM curator_ephemera_patterns WHERE status='approved' AND enabled=1`)
    .all() as Array<{ pattern: string }>;
  const runtimePatterns = patternRows.map((r) => r.pattern);

  // F4: read cursor — default '' means start from beginning
  const cursorRow = db
    .prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`)
    .get() as { value: string } | undefined;
  const cursor = cursorRow?.value ?? '';

  const memories = db
    .prepare(
      `SELECT memory_id, title, body, kind FROM t2_memories
       WHERE retired_at IS NULL AND memory_id > ?
       ORDER BY memory_id ASC LIMIT ?`,
    )
    .all(cursor, batchSize) as Array<{ memory_id: string; title: string; body: string; kind: string }>;

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
    })();
  }

  // F4: advance cursor; wrap to '' when batch exhausted
  if (memories.length > 0) {
    const lastId = memories[memories.length - 1]!.memory_id;
    if (memories.length < batchSize) {
      upsertCursor(db, 'pc1_memory_id', '');
    } else {
      upsertCursor(db, 'pc1_memory_id', lastId);
    }
  }
}
