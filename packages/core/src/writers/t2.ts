import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';

export interface T2MemoryExtraction {
  title: string;
  body: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

export type LLMJudge = (transcript: string) => Promise<T2MemoryExtraction[]>;

export interface T2PromotionOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  llm: LLMJudge;
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
      }, [string]>(
        'SELECT rollup_id, session_id, project_id, user_id, started_at, ended_at FROM t1_rollups WHERE rollup_id = ?',
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
        return `${role}: ${e.payload_summary || '(no content)'}`;
      })
      .join('\n\n');

    if (!transcript.trim()) {
      this.markPromoted(rollupId);
      return 0;
    }

    // TODO: Implement LLM cost heuristics/sampling here.
    // For now, we evaluate every eligible session.
    const extractions = await this.opts.llm(transcript);
    if (extractions.length === 0) {
      this.markPromoted(rollupId);
      return 0;
    }

    const bodies = extractions.map(e => e.body);
    const embeddings = await this.opts.embedder.embed(bodies);

    this.opts.db.exec('BEGIN');
    try {
      for (let i = 0; i < extractions.length; i++) {
        const ext = extractions[i]!;
        const vec = embeddings[i]!;
        const memoryId = this.opts.uuid();
        const now = this.opts.clock().toISOString();

        this.opts.db.run(
          `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                                   window_start, window_end, title, body, metadata_json,
                                   created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ],
        );

        const rowid = this.opts.db
          .query<{ rowid: number }, [string]>('SELECT rowid FROM t2_memories WHERE memory_id=?')
          .get(memoryId)!.rowid;
        this.opts.db.run('INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec]);
      }

      this.markPromoted(rollupId);
      this.opts.db.exec('COMMIT');
    } catch (err) {
      this.opts.db.exec('ROLLBACK');
      throw err;
    }

    return extractions.length;
  }

  private markPromoted(rollupId: string): void {
    this.opts.db.run(
      'UPDATE t1_rollups SET t2_promoted_at = ? WHERE rollup_id = ?',
      [this.opts.clock().toISOString(), rollupId],
    );
  }

  /**
   * Detects rollups that have not been promoted to T2 and are older than delayHours.
   */
  detectEligibleRollups(delayHours: number, now: Date): string[] {
    const cutoff = new Date(now.getTime() - delayHours * 3600_000).toISOString();
    return this.opts.db
      .query<{ rollup_id: string }, [string, string]>(
        'SELECT rollup_id FROM t1_rollups WHERE t2_promoted_at IS NULL AND (ended_at < ? OR (ended_at IS NULL AND started_at < ?))',
      )
      .all(cutoff, cutoff)
      .map((r) => r.rollup_id);
  }
}
