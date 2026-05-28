import type { Database } from "bun:sqlite";

export interface LongLivedRuntimeContext {
  running_agent_id?: string;
  running_tick_id?: string;
}

export interface VerifiedLongLivedRuntimeIdentity {
  agent_id: string;
  tick_id: string;
}

let runtimeContext: LongLivedRuntimeContext = {};

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function setLongLivedRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  runtimeContext = {
    running_agent_id: clean(env.PENUMBRA_LONG_LIVED_AGENT_ID),
    running_tick_id: clean(env.PENUMBRA_LONG_LIVED_TICK_ID),
  };
}

export function getLongLivedRuntimeContext(): LongLivedRuntimeContext {
  return runtimeContext;
}

interface TickIdentityRow {
  agent_id: string;
  terminal_status: string | null;
}

export function verifyRunningIdentity(
  db: Database,
  ctx: LongLivedRuntimeContext,
): VerifiedLongLivedRuntimeIdentity {
  if (!ctx.running_agent_id || !ctx.running_tick_id) {
    throw new Error("no_running_long_lived_tick");
  }

  const row = db
    .query<TickIdentityRow, [string]>(
      `SELECT
       agent_id,
       CASE
         WHEN completed_at IS NOT NULL OR outcome IS NOT NULL THEN 'set'
         ELSE NULL
       END AS terminal_status
     FROM long_lived_ticks
     WHERE id = ?
     LIMIT 1`,
    )
    .get(ctx.running_tick_id);

  if (!row) throw new Error("unknown_long_lived_tick");
  if (row.agent_id !== ctx.running_agent_id) throw new Error("cross_identity_long_lived");
  if (row.terminal_status !== null) throw new Error("tick_terminal_status_set");

  return { agent_id: row.agent_id, tick_id: ctx.running_tick_id };
}
