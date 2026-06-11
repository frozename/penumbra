import type { Database } from "bun:sqlite";
import type { HandoffStatus } from "../schemas/handoff.js";

export interface ChainTerminatedEvent {
  ts: string;
  reason: string;
  hop_count: number;
  terminal_handoff_id?: string;
  conversation_id: string;
}

export interface ChainSummary {
  conversation_id: string;
  project_id: string | null;
  latest_status: HandoffStatus;
  latest_ts: string;
  earliest_ts: string;
  handoff_count: number;
  root_handoff_id: string | null;
  to_agent: string | null;
  to_role: string | null;
}

export interface AgentResponseEvent {
  agent: string;
  text: string;
  error?: { message: string };
  ts: string;
}

export class ChainReader {
  constructor(private readonly db: Database) {}

  getResponses(conversation_id: string, which: "final" | "all" = "final"): AgentResponseEvent[] {
    const orderSql =
      which === "final"
        ? "ORDER BY ts DESC, ingest_ts DESC, event_id DESC"
        : "ORDER BY ts ASC, ingest_ts ASC, event_id ASC";
    const limitSql = which === "final" ? "LIMIT 1" : "";
    const rows = this.db
      .query<
        {
          event_id: string;
          ts: string;
          ingest_ts: string;
          source_detail: string | null;
          source: string;
          user_id: string | null;
          payload_json: string;
        },
        [string]
      >(
        `
      SELECT event_id, ts, ingest_ts, source_detail, source, user_id, payload_json
      FROM t0_events
      WHERE event_type = 'agent-response'
        AND session_id = ?
      ${orderSql}
      ${limitSql}
    `,
      )
      .all(conversation_id);

    return rows.map((row) => {
      const payload = parseAgentResponsePayload(row.payload_json);
      return {
        ts: row.ts,
        agent:
          row.user_id && row.user_id !== "local-user"
            ? row.user_id
            : (row.source_detail ?? row.source),
        text: payload.text,
        ...(payload.error ? { error: { message: payload.error } } : {}),
      };
    });
  }

  listChains(opts: {
    status?: HandoffStatus;
    project_id?: string;
    limit: number;
    offset: number;
  }): ChainSummary[] {
    // A chain = one conversation_id, summarized from its handoffs. The
    // window picks the latest handoff per conversation, ordered by ts DESC.
    // The `status` filter is applied to the *latest* handoff; the
    // `project_id` filter applies to any handoff in the conversation.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) {
      where.push(`latest_status = ?`);
      params.push(opts.status);
    }
    if (opts.project_id) {
      where.push(`(project_id = ? OR project_id IS NULL)`);
      params.push(opts.project_id);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        conversation_id,
        project_id,
        latest_status,
        latest_ts,
        earliest_ts,
        handoff_count,
        root_handoff_id,
        to_agent,
        to_role
      FROM (
        SELECT
          h.conversation_id AS conversation_id,
          (SELECT project_id FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS project_id,
          (SELECT status FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS latest_status,
          MAX(h.ts) AS latest_ts,
          MIN(h.ts) AS earliest_ts,
          COUNT(*) AS handoff_count,
          (SELECT handoff_id FROM handoffs WHERE conversation_id = h.conversation_id AND parent_handoff_id IS NULL ORDER BY ts ASC LIMIT 1) AS root_handoff_id,
          (SELECT to_agent FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS to_agent,
          (SELECT to_role FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS to_role
        FROM handoffs h
        GROUP BY h.conversation_id
      )
      ${whereClause}
      ORDER BY latest_ts DESC
      LIMIT ? OFFSET ?
    `;
    params.push(opts.limit, opts.offset);
    const rows = this.db
      .query<
        {
          conversation_id: string;
          project_id: string | null;
          latest_status: HandoffStatus;
          latest_ts: string;
          earliest_ts: string;
          handoff_count: number;
          root_handoff_id: string | null;
          to_agent: string | null;
          to_role: string | null;
        },
        (string | number)[]
      >(sql)
      .all(...params);
    return rows;
  }

  conversationExists(conversation_id: string): boolean {
    const row = this.db
      .query<{ found: number }, [string, string]>(
        `
      SELECT CASE
        WHEN EXISTS(SELECT 1 FROM t0_events WHERE session_id = ? LIMIT 1) THEN 1
        WHEN EXISTS(SELECT 1 FROM handoffs WHERE conversation_id = ? LIMIT 1) THEN 1
        ELSE 0
      END AS found
    `,
      )
      .get(conversation_id, conversation_id);
    return row?.found === 1;
  }

  listHistory(conversation_id: string, limit: number = 50): ChainTerminatedEvent[] {
    const rows = this.db
      .query<{ ts: string; session_id: string; payload_json: string }, [string, number]>(
        `
      SELECT ts, session_id, payload_json
      FROM t0_events
      WHERE event_type = 'chain-terminated'
        AND session_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `,
      )
      .all(conversation_id, limit);

    return rows.map((row) => {
      let payload: {
        reason?: string | null;
        hop_count?: number | null;
        terminal_handoff_id?: string | null;
      } | null = null;
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (parsed && typeof parsed === "object") {
          payload = parsed as {
            reason?: string | null;
            hop_count?: number | null;
            terminal_handoff_id?: string | null;
          };
        }
      } catch {
        // null is handled below
      }
      return {
        ts: row.ts,
        reason: typeof payload?.reason === "string" ? payload.reason : "unknown",
        hop_count: typeof payload?.hop_count === "number" ? payload.hop_count : 0,
        terminal_handoff_id:
          typeof payload?.terminal_handoff_id === "string"
            ? payload.terminal_handoff_id
            : undefined,
        conversation_id: row.session_id,
      };
    });
  }

  getMessages(
    conversation_id: string,
    types?: string[],
  ): {
    event_id: string;
    ts: string;
    event_type: string;
    source: string;
    source_detail: string | null;
    user_id: string | null;
    payload: unknown;
  }[] {
    let sql = `
      SELECT event_id, ts, event_type, source, source_detail, user_id, payload_json
      FROM t0_events
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [conversation_id];

    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(", ");
      sql += ` AND event_type IN (${placeholders})`;
      params.push(...types);
    }

    sql += ` ORDER BY ts ASC, ingest_ts ASC, event_id ASC`;

    const rows = this.db
      .query<
        {
          event_id: string;
          ts: string;
          event_type: string;
          source: string;
          source_detail: string | null;
          user_id: string | null;
          payload_json: string;
        },
        (string | number)[]
      >(sql)
      .all(...params);

    return rows.map((row) => {
      let payload = null;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // null is returned on malformed json
      }
      return {
        event_id: row.event_id,
        ts: row.ts,
        event_type: row.event_type,
        source: row.source,
        source_detail: row.source_detail,
        user_id: row.user_id,
        payload,
      };
    });
  }
}

function parseAgentResponsePayload(payload_json: string): { text: string; error?: string } {
  try {
    const payload = JSON.parse(payload_json) as {
      response?: unknown;
      error?: unknown;
      text?: unknown;
    };
    if (typeof payload.response === "string") return { text: payload.response };
    if (typeof payload.text === "string") return { text: payload.text };
    if (typeof payload.error === "string") return { text: "", error: payload.error };
    return { text: "" };
  } catch {
    return { text: "", error: "malformed payload_json" };
  }
}
