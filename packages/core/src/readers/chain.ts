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
  handoff_id: string | null;
}

export class ChainReader {
  constructor(private readonly db: Database) {}

  getResponses(
    conversation_id: string,
    which: "final" | "all" = "final",
    opts: { handoff_id?: string; project_id?: string | null } = {},
  ): AgentResponseEvent[] {
    const textSortSql =
      "CASE WHEN json_valid(payload_json) THEN (json_extract(payload_json, '$.text') IS NOT NULL AND json_extract(payload_json, '$.response') IS NULL) ELSE 0 END";
    const orderSql =
      which === "final"
        ? `ORDER BY (${textSortSql}) ASC, ts DESC, ingest_ts DESC, event_id DESC`
        : "ORDER BY ts ASC, ingest_ts ASC, event_id ASC";
    const limitSql = which === "final" ? "LIMIT 1" : "";
    type ResponseRow = {
      event_id: string;
      ts: string;
      ingest_ts: string;
      source_detail: string | null;
      source: string;
      user_id: string | null;
      payload_json: string;
    };
    // NOTE: deliberately NOT scoped by project_id even though the
    // project+session index would make the lookup cheaper — t0 agent-response
    // rows do not reliably carry the handoff's project_id (ingestion can stamp
    // null), so filtering on it silently drops legitimate responses and
    // regresses completed_with_output to no_changes. Optional scoping remains
    // available to callers that can guarantee their rows are stamped.
    const projectClause = typeof opts.project_id === "string" ? "AND project_id = ?" : "";
    const projectArgs: string[] = typeof opts.project_id === "string" ? [opts.project_id] : [];
    const baseSelect = `
      SELECT event_id, ts, ingest_ts, source_detail, source, user_id, payload_json
      FROM t0_events
      WHERE event_type = 'agent-response'
        AND session_id = ?
        ${projectClause}
    `;
    const orderLimit = `
      ${orderSql}
      ${limitSql}
    `;
    // When a handoff scope is present, fail closed with an exact payload
    // handoff_id match. Unstamped rows are only visible to unscoped callers.
    const handoffScope = opts.handoff_id;
    const rows =
      handoffScope !== undefined
        ? this.db
            .query<
              ResponseRow,
              string[]
            >(`${baseSelect} AND json_valid(payload_json) AND json_extract(payload_json, '$.handoff_id') = ? ${orderLimit}`)
            .all(conversation_id, ...projectArgs, handoffScope)
        : this.db
            .query<ResponseRow, string[]>(`${baseSelect}${orderLimit}`)
            .all(conversation_id, ...projectArgs);

    const responses = rows.map((row) => {
      const payload = parseAgentResponsePayload(row.payload_json);
      return {
        ts: row.ts,
        agent:
          payload.agent ||
          row.source_detail ||
          (row.user_id && row.user_id !== "local-user" ? row.user_id : row.source),
        text: payload.text,
        handoff_id: payload.handoff_id,
        kind: payload.kind,
        ...(payload.error ? { error: { message: payload.error } } : {}),
      };
    });
    if (which !== "all") {
      return responses.map(({ kind: _kind, ...response }) => response);
    }

    const handoffIdsWithTurns = new Set(
      responses
        .filter((response) => response.kind === "turn" && response.handoff_id !== null)
        .map((response) => response.handoff_id),
    );
    return responses
      .filter(
        (response) =>
          response.kind !== "segment" ||
          response.handoff_id === null ||
          !handoffIdsWithTurns.has(response.handoff_id),
      )
      .map(({ kind: _kind, ...response }) => response);
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
    // `project_id` filter applies to the latest handoff's project_id (or NULL).
    //
    // Window-function rewrite: the previous implementation ran 6 correlated
    // subqueries per conversation across ALL conversations before LIMIT/OFFSET.
    // This version makes one pass over handoffs, picks the latest row per
    // conversation_id via ROW_NUMBER, and computes COUNT/MIN/MAX via window
    // aggregates — same result set, columns, and ordering.
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
      WITH ranked AS (
        SELECT
          conversation_id,
          project_id,
          status,
          ts,
          to_agent,
          to_role,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY ts DESC) AS rn_latest,
          MIN(ts) OVER (PARTITION BY conversation_id) AS earliest_ts,
          MAX(ts) OVER (PARTITION BY conversation_id) AS latest_ts,
          COUNT(*) OVER (PARTITION BY conversation_id) AS handoff_count
        FROM handoffs
      ),
      roots AS (
        SELECT
          conversation_id,
          handoff_id,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY ts ASC) AS rn_root
        FROM handoffs
        WHERE parent_handoff_id IS NULL
      )
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
          r.conversation_id AS conversation_id,
          r.project_id AS project_id,
          r.status AS latest_status,
          r.latest_ts AS latest_ts,
          r.earliest_ts AS earliest_ts,
          r.handoff_count AS handoff_count,
          rt.handoff_id AS root_handoff_id,
          r.to_agent AS to_agent,
          r.to_role AS to_role
        FROM ranked r
        LEFT JOIN roots rt
          ON rt.conversation_id = r.conversation_id AND rt.rn_root = 1
        WHERE r.rn_latest = 1
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

  listHistory(conversation_id: string, limit = 50): ChainTerminatedEvent[] {
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
          payload = parsed;
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
    opts: { limit?: number; offset?: number; before_ts?: string } = {},
  ): {
    event_id: string;
    ts: string;
    event_type: string;
    source: string;
    source_detail: string | null;
    user_id: string | null;
    payload: unknown;
  }[] {
    // High default so existing small-conversation reads remain functionally
    // unchanged. Pathological conversations (thousands of events) were
    // returning an unbounded result set and JSON.parsing every row — the
    // cap bounds that worst case without truncating typical reads.
    const DEFAULT_LIMIT = 1000;
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.floor(opts.limit)
        : DEFAULT_LIMIT;
    const offset =
      typeof opts.offset === "number" && Number.isFinite(opts.offset) && opts.offset >= 0
        ? Math.floor(opts.offset)
        : 0;

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

    if (typeof opts.before_ts === "string" && opts.before_ts.length > 0) {
      sql += ` AND ts < ?`;
      params.push(opts.before_ts);
    }

    sql += ` ORDER BY ts ASC, ingest_ts ASC, event_id ASC`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

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
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
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

function parseAgentResponsePayload(payload_json: string): {
  text: string;
  error?: string;
  handoff_id: string | null;
  agent: string | null;
  kind: "turn" | "segment" | "other";
} {
  try {
    const payload = JSON.parse(payload_json) as {
      response?: unknown;
      error?: unknown;
      text?: unknown;
      handoff_id?: unknown;
      agent?: unknown;
    };
    const handoff_id = typeof payload.handoff_id === "string" ? payload.handoff_id : null;
    const agent = typeof payload.agent === "string" && payload.agent !== "" ? payload.agent : null;
    if (typeof payload.response === "string")
      return { text: payload.response, handoff_id, agent, kind: "turn" };
    if (typeof payload.text === "string")
      return { text: payload.text, handoff_id, agent, kind: "segment" };
    if (typeof payload.error === "string")
      return { text: "", error: payload.error, handoff_id, agent, kind: "other" };
    return { text: "", handoff_id, agent, kind: "other" };
  } catch {
    return {
      text: "",
      error: "malformed payload_json",
      handoff_id: null,
      agent: null,
      kind: "other",
    };
  }
}
