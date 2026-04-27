import type { Database } from 'bun:sqlite';

export interface ChainTerminatedEvent {
  ts: string;
  reason: string;
  hop_count: number;
  terminal_handoff_id?: string;
  conversation_id: string;
}

export interface AgentResponseEvent {
  agent: string;
  text: string;
  ts: string;
}

export class ChainReader {
  constructor(private readonly db: Database) {}

  getResponses(conversation_id: string, which: 'final' | 'all' = 'final'): AgentResponseEvent[] {
    const limitSql = which === 'final' ? 'LIMIT 1' : '';
    const rows = this.db.query<
      { ts: string; source_detail: string | null; source: string; payload_json: string },
      [string]
    >(`
      SELECT ts, source_detail, source, payload_json
      FROM t0_events
      WHERE event_type = 'agent-response'
        AND session_id = ?
      ORDER BY ts DESC
      ${limitSql}
    `).all(conversation_id);

    const mapped = rows.map((row) => {
      const payload = JSON.parse(row.payload_json);
      return {
        ts: row.ts,
        agent: row.source_detail ?? row.source,
        text: payload.response ?? '',
      };
    });

    if (which === 'all') {
      return mapped.reverse();
    }
    return mapped;
  }

  listHistory(conversation_id: string, limit: number = 50): ChainTerminatedEvent[] {
    const rows = this.db.query<
      { ts: string; session_id: string; payload_json: string },
      [string, number]
    >(`
      SELECT ts, session_id, payload_json
      FROM t0_events
      WHERE event_type = 'chain-terminated'
        AND session_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(conversation_id, limit);

    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json);
      return {
        ts: row.ts,
        reason: payload.reason,
        hop_count: payload.hop_count,
        terminal_handoff_id: payload.terminal_handoff_id,
        conversation_id: row.session_id,
      };
    });
  }
}
