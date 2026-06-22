import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { Database } from "bun:sqlite";

type AgentConfig = Parameters<typeof reconcileLongLivedAgents>[1][number];
type LongLivedConfig = NonNullable<AgentConfig["long_lived_config"]>;

export interface MkAgentOverrides {
  name?: string;
  standing_brief?: string;
  schedule_cron?: string | null;
}

export function mkLongLivedAgent(overrides: MkAgentOverrides = {}): AgentConfig {
  const name = overrides.name ?? "a";
  const standingBrief = overrides.standing_brief ?? "x";
  const scheduleCron =
    overrides.schedule_cron === undefined ? "*/15 * * * *" : overrides.schedule_cron;
  const longLivedConfig: LongLivedConfig = {
    subscriptions: [],
    hosted_mcp_servers: [],
    mcp_allowlist: [],
    require_snapshot: false,
    bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3,
    standing_brief: standingBrief,
    ...(scheduleCron === null ? {} : { schedule_cron: scheduleCron }),
  };
  return {
    name,
    adapter: "stdio-acp",
    options: {},
    roles: [],
    auto_approve_to: [],
    pricing_mode: "api",
    long_lived: true,
    long_lived_config: longLivedConfig,
  };
}

export function reconcileLongLivedTestAgents(
  db: Database,
  overrides: MkAgentOverrides[],
  now = 1,
): void {
  reconcileLongLivedAgents(
    db,
    overrides.map((override) => mkLongLivedAgent(override)),
    { now },
  );
}

export function seedLongLivedAgent(db: Database, overrides: MkAgentOverrides = {}): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedTestAgents(db, [overrides]);
}

export function insertLongLivedTick(
  db: Database,
  opts: { tick_id: string; agent_id: string; started_at?: number },
): void {
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, ?, 'manual', ?)",
  ).run(opts.tick_id, opts.agent_id, opts.started_at ?? 1);
}
