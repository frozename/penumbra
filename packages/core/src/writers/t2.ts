import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Embedder } from '../embedder/interface.js';
import { T2MemoryWriteSchema, type T2MemoryWriteInput } from '../schemas/memory.js';
import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';

export const T2MemoryExtractionSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type T2MemoryExtraction = z.infer<typeof T2MemoryExtractionSchema>;

export type LLMJudge = (transcript: string) => Promise<T2MemoryExtraction[]>;

export type T2MemoryWriterInput = T2MemoryWriteInput;

export function verifyMemory(db: Database, memoryId: string): { memory_id: string; last_verified_at: string } | null {
  const row = db
    .query<{ memory_id: string }, [string]>('SELECT memory_id FROM t2_memories WHERE memory_id = ?')
    .get(memoryId);
  if (!row) return null;

  const now = new Date().toISOString();
  db.run('UPDATE t2_memories SET last_verified_at = ? WHERE memory_id = ?', [now, memoryId]);
  return { memory_id: memoryId, last_verified_at: now };
}

export async function writeT2Memory(db: Database, input: T2MemoryWriterInput): Promise<void> {
  const rec = T2MemoryWriteSchema.parse(input);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.run(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                               window_start, window_end, title, body, metadata_json,
                               compressed_from, created_at, updated_at,
                               obs_type, concepts, severity, file_paths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.memory_id,
        rec.project_id ?? null,
        rec.user_id,
        rec.kind,
        JSON.stringify(rec.source_session_ids ?? []),
        rec.window_start,
        rec.window_end,
        rec.title,
        rec.body,
        JSON.stringify(rec.metadata ?? {}),
        rec.compressed_from ?? null,
        now,
        now,
        rec.obs_type ?? null,
        JSON.stringify(rec.concepts ?? []),
        rec.severity ?? null,
        JSON.stringify(rec.file_paths ?? []),
      ],
    );

    const rowid = db
      .query<{ rowid: number }, [string]>('SELECT rowid FROM t2_memories WHERE memory_id=?')
      .get(rec.memory_id)!.rowid;
    db.run('INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)', [rowid, rec.embedding]);
  })();
}

export interface T2PromotionOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  llm: LLMJudge;
  retryLimit?: number;
  minEvents?: number;
}

export class T2Promotion {
  constructor(private readonly opts: T2PromotionOpts) {}

  /**
   * Promotes a T1 rollup to T2 memories using an LLM judge.
   * Returns the number of memories created.
   */
  async promoteRollup(rollupId: string): Promise<number> {
    const rollup = this.opts.db
      .query<{
        rollup_id: string;
        session_id: string;
        project_id: string | null;
        user_id: string;
        started_at: string;
        ended_at: string | null;
        origin: string | null;
      }, [string]>(
        'SELECT rollup_id, session_id, project_id, user_id, started_at, ended_at, origin FROM t1_rollups WHERE rollup_id = ?',
      )
      .get(rollupId);

    if (!rollup) return 0;

    // Fetch transcript from t0_events
    const events = this.opts.db
      .query<{ event_type: string; payload_summary: string | null }, [string]>(
        'SELECT event_type, payload_summary FROM t0_events WHERE session_id = ? ORDER BY ts ASC',
      )
      .all(rollup.session_id);

    if (events.length === 0) {
      this.markPromoted(rollupId);
      return 0;
    }

    const transcript = events
      .filter(e => e.event_type === 'agent-prompt' || e.event_type === 'agent-response')
      .map((e) => {
        const role = e.event_type === 'agent-prompt' ? 'User' : 'Assistant';
        const content = (e.payload_summary || '').trim();
        return content ? `${role}: ${content}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    if (!transcript) {
      this.markPromoted(rollupId);
      return 0;
    }

    try {
      // TODO: Implement LLM cost heuristics/sampling here.
      // For now, we evaluate every eligible session.
      const rawExtractions = await this.opts.llm(transcript);

      // LLM response schema validation
      const extractions: T2MemoryExtraction[] = [];
      for (const ext of rawExtractions) {
        const result = T2MemoryExtractionSchema.safeParse(ext);
        if (result.success) {
          extractions.push(result.data);
        } else {
          // If any extraction is malformed, we fail the whole rollup to avoid partial/garbage data.
          throw new Error(`LLM extraction failed validation: ${result.error.message}`);
        }
      }

      if (extractions.length === 0) {
        this.markPromoted(rollupId);
        return 0;
      }

      const bodies = extractions.map(e => e.body);
      const embeddings = await this.opts.embedder.embed(bodies);

      this.opts.db.transaction(() => {
        for (let i = 0; i < extractions.length; i++) {
          const ext = extractions[i]!;
          const vec = embeddings[i]!;
          const memoryId = this.opts.uuid();
          const now = this.opts.clock().toISOString();

          this.opts.db.run(
            `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                                     window_start, window_end, title, body, metadata_json,
                                     created_at, updated_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              memoryId,
              rollup.project_id,
              rollup.user_id,
              ext.kind,
              JSON.stringify([rollup.session_id]),
              rollup.started_at,
              rollup.ended_at || rollup.started_at,
              ext.title,
              ext.body,
              JSON.stringify(ext.metadata || {}),
              now,
              now,
              rollup.origin,
            ],
          );

          const rowid = this.opts.db
            .query<{ rowid: number }, [string]>('SELECT rowid FROM t2_memories WHERE memory_id=?')
            .get(memoryId)!.rowid;
          this.opts.db.run('DELETE FROM t2_vec WHERE rowid = ?', [rowid]);
          this.opts.db.run('INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec]);
        }

        this.markPromoted(rollupId);
      })();

      return extractions.length;
    } catch (err) {
      this.recordFailure(rollupId);
      throw err;
    }
  }

  private markPromoted(rollupId: string): void {
    this.opts.db.run(
      'UPDATE t1_rollups SET t2_promoted_at = ?, failed_promotion_attempts = 0 WHERE rollup_id = ?',
      [this.opts.clock().toISOString(), rollupId],
    );
  }

  private recordFailure(rollupId: string): void {
    this.opts.db.run(
      'UPDATE t1_rollups SET failed_promotion_attempts = failed_promotion_attempts + 1 WHERE rollup_id = ?',
      [rollupId],
    );
  }

  /**
   * Detects rollups that have not been promoted to T2 and are older than delayHours.
   * Skips rollups that have reached the retry limit.
   */
  detectEligibleRollups(delayHours: number, now: Date, minEvents?: number): string[] {
    const cutoff = new Date(now.getTime() - delayHours * 3600_000).toISOString();
    const limit = this.opts.retryLimit ?? 5;
    const finalMinEvents = minEvents ?? this.opts.minEvents ?? 5;
    return this.opts.db
      .query<{ rollup_id: string }, [string, string, number, number]>(
        `SELECT rollup_id FROM t1_rollups 
         WHERE t2_promoted_at IS NULL 
           AND (ended_at < ? OR (ended_at IS NULL AND started_at < ?))
           AND failed_promotion_attempts < ?
           AND n_events >= ?`,
      )
      .all(cutoff, cutoff, limit, finalMinEvents)
      .map((r) => r.rollup_id);
  }
}
