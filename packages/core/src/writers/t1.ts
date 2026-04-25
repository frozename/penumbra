import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';

export interface T1RollupOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
}

interface T0Row {
  event_id: string;
  project_id: string | null;
  user_id: string;
  session_id: string;
  ts: string;
  lane: string;
  provider: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  event_type: string;
  payload_summary: string | null;
}

function isUniqueViolation(err: unknown, indexName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; message?: string };
  return e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.message?.includes(indexName) ?? false);
}

export class T1Rollup {
  constructor(private readonly opts: T1RollupOpts) {}

  async rollupSession(sessionId: string): Promise<string | null> {
    // Skip if already rolled up.
    const existing = this.opts.db
      .query<{ rollup_id: string }, [string]>(
        'SELECT rollup_id FROM t1_rollups WHERE session_id=?',
      )
      .get(sessionId);
    if (existing) return null;

    const rows = this.opts.db
      .query<T0Row, [string]>(
        `SELECT event_id, project_id, user_id, session_id, ts, lane, provider,
                tokens_in, tokens_out, cost_usd, event_type, payload_summary
           FROM t0_events
          WHERE session_id = ?
          ORDER BY ts ASC`,
      )
      .all(sessionId);

    if (rows.length === 0) return null;

    const first = rows[0]!;
    const last = rows[rows.length - 1]!;

    const laneBreakdown: Record<string, number> = {};
    const providerBreakdown: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let firstPrompt: string | null = null;
    let lastResponse: string | null = null;

    for (const row of rows) {
      laneBreakdown[row.lane] = (laneBreakdown[row.lane] ?? 0) + 1;
      if (row.provider) providerBreakdown[row.provider] = (providerBreakdown[row.provider] ?? 0) + 1;
      if (row.event_type === 'agent-tool-use' && row.payload_summary) {
        // payload_summary convention for agent-tool-use: "<toolName> <args...>"; first token is the tool name.
        const toolName = row.payload_summary.split(' ')[0]!;
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      }
      if (row.event_type === 'agent-prompt' && firstPrompt === null) {
        firstPrompt = row.payload_summary;
      }
      if (row.event_type === 'agent-response') {
        lastResponse = row.payload_summary;
      }
      tokensIn += row.tokens_in ?? 0;
      tokensOut += row.tokens_out ?? 0;
      cost += row.cost_usd ?? 0;
    }

    const toolCallsSummary = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${n} ${name}`)
      .join(', ');

    const rollupId = this.opts.uuid();
    const embedText = [firstPrompt, lastResponse].filter(Boolean).join('\n\n') || 'empty session';
    const [vec] = await this.opts.embedder.embed([embedText]);

    this.opts.db.exec('BEGIN');
    try {
      this.opts.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                                 n_events, lane_breakdown_json, provider_breakdown_json,
                                 cost_usd_total, tokens_in_total, tokens_out_total,
                                 first_prompt_excerpt, last_response_excerpt, tool_calls_summary,
                                 source_event_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rollupId,
          first.project_id,
          first.user_id,
          sessionId,
          first.ts,
          last.ts,
          rows.length,
          JSON.stringify(laneBreakdown),
          JSON.stringify(providerBreakdown),
          cost || null,
          tokensIn || null,
          tokensOut || null,
          firstPrompt,
          lastResponse,
          toolCallsSummary || null,
          JSON.stringify(rows.map((r) => r.event_id)),
        ],
      );
      const rowid = this.opts.db
        .query<{ rowid: number }, [string]>('SELECT rowid FROM t1_rollups WHERE rollup_id=?')
        .get(rollupId)!.rowid;
      this.opts.db.run('INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec!]);
      this.opts.db.exec('COMMIT');
    } catch (err) {
      this.opts.db.exec('ROLLBACK');
      if (isUniqueViolation(err, 't1_session')) {
        // Lost the race against another rollup of this session — caller's intent is satisfied.
        return null;
      }
      throw err;
    }
    return rollupId;
  }

  detectIdleSessions(idleMinutes: number, now: Date): string[] {
    type Row = { session_id: string };
    const cutoff = new Date(now.getTime() - idleMinutes * 60_000).toISOString();
    return this.opts.db
      .query<Row, [string]>(
        `SELECT t.session_id
           FROM t0_events t
          WHERE t.session_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM t1_rollups r WHERE r.session_id = t.session_id)
          GROUP BY t.session_id
         HAVING MAX(t.ts) < ?`,
      )
      .all(cutoff)
      .map((r) => r.session_id);
  }
}
