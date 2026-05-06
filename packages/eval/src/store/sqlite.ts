import { Database } from 'bun:sqlite';

export interface LeaderboardRow {
  model_id: string;
  node: string;
  ub: number;
  throughput_tps: number;
  tool_call_score: number;
  context_8k_score: number;
  context_16k_score: number | null;
  json_score: number;
  composite_score: number;
  source: string;
  updated_at: string;
}

export interface QueryFilter {
  node?: string;
  min_throughput?: number;
  min_tool_call_score?: number;
  sort_by?: keyof Pick<LeaderboardRow, 'throughput_tps' | 'tool_call_score' | 'context_8k_score' | 'context_16k_score' | 'json_score' | 'composite_score'>;
}

function ensureSchema(db: Database): void {
  db.run(`create table if not exists leaderboard (
    model_id text not null,
    node text not null,
    ub integer not null,
    throughput_tps real not null,
    tool_call_score real not null,
    context_8k_score real not null,
    context_16k_score real,
    json_score real not null,
    composite_score real not null,
    source text not null,
    updated_at text not null,
    primary key (model_id, node, ub)
  )`);
}

export function upsertRow(db: Database, row: Omit<LeaderboardRow, 'updated_at'>): void {
  ensureSchema(db);
  db.query(
    `insert into leaderboard (
      model_id, node, ub, throughput_tps, tool_call_score, context_8k_score, context_16k_score, json_score, composite_score, source, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    on conflict(model_id, node, ub) do update set
      throughput_tps=excluded.throughput_tps,
      tool_call_score=excluded.tool_call_score,
      context_8k_score=excluded.context_8k_score,
      context_16k_score=excluded.context_16k_score,
      json_score=excluded.json_score,
      composite_score=excluded.composite_score,
      source=excluded.source,
      updated_at=excluded.updated_at`,
  ).run(
    row.model_id,
    row.node,
    row.ub,
    row.throughput_tps,
    row.tool_call_score,
    row.context_8k_score,
    row.context_16k_score ?? null,
    row.json_score,
    row.composite_score,
    row.source,
  );
}

export function queryRows(db: Database, filter: QueryFilter): LeaderboardRow[] {
  ensureSchema(db);
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filter.node) {
    clauses.push('node = ?');
    values.push(filter.node);
  }
  if (filter.min_throughput != null) {
    clauses.push('throughput_tps >= ?');
    values.push(filter.min_throughput);
  }
  if (filter.min_tool_call_score != null) {
    clauses.push('tool_call_score >= ?');
    values.push(filter.min_tool_call_score);
  }
  const orderBy = filter.sort_by ?? 'composite_score';
  const sql = `select * from leaderboard${clauses.length ? ` where ${clauses.join(' and ')}` : ''} order by ${orderBy} desc, model_id asc`;
  return db.query(sql).all(...values) as LeaderboardRow[];
}
