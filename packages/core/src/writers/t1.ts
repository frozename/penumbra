import { Database } from "bun:sqlite";

import type { Embedder } from "../embedder/interface.js";
import type { Clock } from "../utils/clock.js";
import type { Uuid } from "../utils/uuid.js";

export interface T1RollupOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  overwriteOnReroll?: boolean;
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
  origin: string | null;
}

interface RollupAggregate {
  laneBreakdown: Record<string, number>;
  providerBreakdown: Record<string, number>;
  toolCallsSummary: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  firstPrompt: string | null;
  lastResponse: string | null;
}

// Priority-pick the rollup origin from constituent events. A maestro-touched
// rollup stays in scope so it survives downstream origin filters.
function pickOrigin(rows: { origin: string | null }[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    if (r.origin === "maestro") return "maestro";
    if (r.origin === "dispatch") best = "dispatch";
    else if (r.origin === "unknown" && best === null) best = "unknown";
  }
  return best;
}

function isUniqueViolation(err: unknown, indexName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string };
  return e.code === "SQLITE_CONSTRAINT_UNIQUE" || (e.message?.includes(indexName) ?? false);
}

function applyRowToAggregate(row: T0Row, state: AggregateState): void {
  state.laneBreakdown[row.lane] = (state.laneBreakdown[row.lane] ?? 0) + 1;
  if (row.provider) {
    state.providerBreakdown[row.provider] = (state.providerBreakdown[row.provider] ?? 0) + 1;
  }
  if (row.event_type === "agent-tool-use" && row.payload_summary) {
    const toolName = row.payload_summary.split(" ")[0] ?? "";
    if (toolName) state.toolCounts[toolName] = (state.toolCounts[toolName] ?? 0) + 1;
  }
  if (row.event_type === "agent-prompt" && state.firstPrompt === null) {
    state.firstPrompt = row.payload_summary;
  }
  if (row.event_type === "agent-response") state.lastResponse = row.payload_summary;
  state.tokensIn += row.tokens_in ?? 0;
  state.tokensOut += row.tokens_out ?? 0;
  state.cost += row.cost_usd ?? 0;
}

interface AggregateState {
  laneBreakdown: Record<string, number>;
  providerBreakdown: Record<string, number>;
  toolCounts: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  firstPrompt: string | null;
  lastResponse: string | null;
}

function aggregateRows(rows: T0Row[]): RollupAggregate {
  const state: AggregateState = {
    laneBreakdown: {},
    providerBreakdown: {},
    toolCounts: {},
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    firstPrompt: null,
    lastResponse: null,
  };
  for (const row of rows) applyRowToAggregate(row, state);

  const toolCallsSummary = Object.entries(state.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${String(n)} ${name}`)
    .join(", ");

  return {
    laneBreakdown: state.laneBreakdown,
    providerBreakdown: state.providerBreakdown,
    toolCallsSummary,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    cost: state.cost,
    firstPrompt: state.firstPrompt,
    lastResponse: state.lastResponse,
  };
}

function embedTextFor(agg: RollupAggregate): string {
  return [agg.firstPrompt, agg.lastResponse].filter(Boolean).join("\n\n") || "empty session";
}

export class T1Rollup {
  constructor(private readonly opts: T1RollupOpts) {}

  async rollupSession(sessionId: string, overwriteOnReroll?: boolean): Promise<string | null> {
    const finalOverwrite = overwriteOnReroll ?? this.opts.overwriteOnReroll;
    const existing = this.opts.db
      .query<
        { rollup_id: string; n_events: number; rowid: number; ended_at: string },
        [string]
      >("SELECT rollup_id, n_events, rowid, ended_at FROM t1_rollups WHERE session_id=?")
      .get(sessionId);

    const rows = this.opts.db
      .query<T0Row, [string]>(
        `SELECT event_id, project_id, user_id, session_id, ts, lane, provider,
                tokens_in, tokens_out, cost_usd, event_type, payload_summary, origin
           FROM t0_events
          WHERE session_id = ?
          ORDER BY ts ASC`,
      )
      .all(sessionId);

    if (rows.length === 0) return null;

    if (existing && !finalOverwrite) {
      return await this.appendRollup(sessionId, existing, rows);
    }
    if (existing && finalOverwrite) {
      this.opts.db.run("DELETE FROM t1_vec WHERE rowid=?", [existing.rowid]);
      this.opts.db.run("DELETE FROM t1_rollups WHERE session_id=?", [sessionId]);
    }
    return await this.insertRollup(sessionId, rows);
  }

  private async appendRollup(
    sessionId: string,
    existing: { rollup_id: string; rowid: number; ended_at: string },
    rows: T0Row[],
  ): Promise<string | null> {
    const last = rows[rows.length - 1];
    if (!last) return null;
    // Compare event recency, not raw row count. If t0 has been pruned below
    // the stored n_events, rows.length stays under it forever and append
    // never fires again for this rollup. last.ts > existing.ended_at fires
    // whenever a newer event arrives, regardless of how many old events
    // have been pruned.
    if (last.ts <= existing.ended_at) return null;

    const agg = aggregateRows(rows);
    // Recompute the embedding for the appended window. The append branch used
    // to leave t1_vec stale — mirror the fresh-insert path: re-embed and
    // DELETE+INSERT the t1_vec row inside the same transaction.
    const [vec] = await this.opts.embedder.embed([embedTextFor(agg)]);
    if (!vec) throw new Error("embedder returned no vector for t1 rollup");

    this.opts.db.run("BEGIN");
    try {
      this.opts.db.run(
        `UPDATE t1_rollups SET
           ended_at=?, n_events=?, lane_breakdown_json=?, provider_breakdown_json=?,
           cost_usd_total=?, tokens_in_total=?, tokens_out_total=?,
           last_response_excerpt=?, tool_calls_summary=?, source_event_ids=?,
           origin=?
         WHERE session_id=?`,
        [
          last.ts,
          rows.length,
          JSON.stringify(agg.laneBreakdown),
          JSON.stringify(agg.providerBreakdown),
          agg.cost || null,
          agg.tokensIn || null,
          agg.tokensOut || null,
          agg.lastResponse,
          agg.toolCallsSummary || null,
          JSON.stringify(rows.map((r) => r.event_id)),
          pickOrigin(rows),
          sessionId,
        ],
      );
      this.opts.db.run("DELETE FROM t1_vec WHERE rowid=?", [existing.rowid]);
      this.opts.db.run("INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)", [existing.rowid, vec]);
      this.opts.db.run("COMMIT");
    } catch (err) {
      this.opts.db.run("ROLLBACK");
      throw err;
    }
    return existing.rollup_id;
  }

  private async insertRollup(sessionId: string, rows: T0Row[]): Promise<string | null> {
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return null;

    const agg = aggregateRows(rows);
    const rollupId = this.opts.uuid();
    const [vec] = await this.opts.embedder.embed([embedTextFor(agg)]);
    if (!vec) throw new Error("embedder returned no vector for t1 rollup");

    this.opts.db.run("BEGIN");
    try {
      this.opts.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                                 n_events, lane_breakdown_json, provider_breakdown_json,
                                 cost_usd_total, tokens_in_total, tokens_out_total,
                                 first_prompt_excerpt, last_response_excerpt, tool_calls_summary,
                                 source_event_ids, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rollupId,
          first.project_id,
          first.user_id,
          sessionId,
          first.ts,
          last.ts,
          rows.length,
          JSON.stringify(agg.laneBreakdown),
          JSON.stringify(agg.providerBreakdown),
          agg.cost || null,
          agg.tokensIn || null,
          agg.tokensOut || null,
          agg.firstPrompt,
          agg.lastResponse,
          agg.toolCallsSummary || null,
          JSON.stringify(rows.map((r) => r.event_id)),
          pickOrigin(rows),
        ],
      );
      const rowidRow = this.opts.db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM t1_rollups WHERE rollup_id=?")
        .get(rollupId);
      if (!rowidRow) throw new Error(`t1 rollup row missing immediately after insert: ${rollupId}`);
      this.opts.db.run("INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)", [rowidRow.rowid, vec]);
      this.opts.db.run("COMMIT");
    } catch (err) {
      this.opts.db.run("ROLLBACK");
      if (isUniqueViolation(err, "t1_session")) {
        // Lost the race against another rollup of this session — caller's intent is satisfied.
        return null;
      }
      throw err;
    }
    return rollupId;
  }

  detectIdleSessions(idleMinutes: number, now: Date, opts?: { ingestedSince?: string }): string[] {
    type Row = { session_id: string };
    const cutoff = new Date(now.getTime() - idleMinutes * 60_000).toISOString();
    const rows =
      opts?.ingestedSince === undefined
        ? this.opts.db
            .query<Row, [string]>(
              `SELECT t.session_id
                 FROM t0_events t
                 LEFT JOIN t1_rollups r ON r.session_id = t.session_id
                WHERE t.session_id IS NOT NULL
                GROUP BY t.session_id
               HAVING (COUNT(r.rollup_id) = 0 OR MAX(t.ts) > MAX(r.ended_at))
                  AND MAX(t.ts) < ?`,
            )
            .all(cutoff)
        : this.opts.db
            .query<Row, [string, string]>(
              `SELECT t.session_id
                 FROM t0_events t
                 LEFT JOIN t1_rollups r ON r.session_id = t.session_id
                WHERE t.session_id IS NOT NULL
                  AND t.session_id IN (
                    SELECT session_id FROM t0_events
                     WHERE ingest_ts >= ? AND session_id IS NOT NULL
                  )
                GROUP BY t.session_id
               HAVING (COUNT(r.rollup_id) = 0 OR MAX(t.ts) > MAX(r.ended_at))
                  AND MAX(t.ts) < ?`,
            )
            .all(opts.ingestedSince, cutoff);
    return rows.map((r) => r.session_id);
  }
}
