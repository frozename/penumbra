import type { Database } from 'bun:sqlite';
import type { AgentConfig } from '@penumbra/agentchat/config';
import type { WorkingMemory } from '@penumbra/core/long-lived/types';

const FORCED_TOOLS = [
  'penumbra:long_lived_self_state_get',
  'penumbra:long_lived_self_state_set',
  'penumbra:long_lived_self_pending_actions',
];

function emptyWorkingMemory(now: number): WorkingMemory {
  return {
    version: 1,
    updated_at: now,
    pending_goals: [],
    open_threads: [],
    watches: [],
    recent_decisions: [],
  };
}

function effectiveAllowlist(declared: readonly string[]): string[] {
  const set = new Set(declared);
  for (const t of FORCED_TOOLS) set.add(t);
  return Array.from(set).sort();
}

export interface ReconcileResult {
  inserted: string[];
  updated: string[];
  retired: string[];
}

export function reconcileLongLivedAgents(
  db: Database,
  agents: readonly AgentConfig[],
  opts: { now: number }
): ReconcileResult {
  const yamlLongLived = agents.filter((a) => a.long_lived === true && a.long_lived_config !== undefined);
  const yamlIds = new Set(yamlLongLived.map((a) => a.name));

  const dbRows = db.query<{ id: string; status: string }, []>(
    'SELECT id, status FROM long_lived_agents'
  ).all();
  const dbIds = new Set(dbRows.map((r) => r.id));

  const inserted: string[] = [];
  const updated: string[] = [];
  const retired: string[] = [];

  for (const a of yamlLongLived) {
    const cfg = a.long_lived_config!;
    const allowlist = JSON.stringify(effectiveAllowlist(cfg.mcp_allowlist));
    const globs = JSON.stringify(cfg.action_tiers?.approval_required_globs ?? []);
    const overrides = JSON.stringify(cfg.action_tiers?.cooldown_overrides ?? {});
    const subs = JSON.stringify(cfg.subscriptions ?? []);

    if (!dbIds.has(a.name)) {
      db.query(`INSERT INTO long_lived_agents (
        id, display_name, status, consecutive_failures, circuit_breaker_threshold,
        schedule_cron, subscriptions_json, mcp_allowlist_json,
        approval_required_globs_json, cooldown_overrides_json,
        bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
        working_memory_json, standing_brief, created_at, updated_at
      ) VALUES (?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        a.name,
        (a as any).display_name ?? a.name,
        cfg.circuit_breaker_threshold ?? 3,
        cfg.schedule_cron ?? null,
        subs,
        allowlist,
        globs,
        overrides,
        cfg.bounds.wall_clock_ms,
        cfg.bounds.cost_cents,
        cfg.bounds.max_sub_dispatches,
        JSON.stringify(emptyWorkingMemory(opts.now)),
        cfg.standing_brief,
        opts.now,
        opts.now,
      );
      inserted.push(a.name);
    } else {
      db.query(`UPDATE long_lived_agents SET
        display_name = ?, schedule_cron = ?, subscriptions_json = ?, mcp_allowlist_json = ?,
        approval_required_globs_json = ?, cooldown_overrides_json = ?,
        bounds_wall_clock_ms = ?, bounds_cost_cents = ?, bounds_max_sub_dispatches = ?,
        circuit_breaker_threshold = ?, standing_brief = ?, updated_at = ?
       WHERE id = ?`).run(
        (a as any).display_name ?? a.name,
        cfg.schedule_cron ?? null,
        subs, allowlist, globs, overrides,
        cfg.bounds.wall_clock_ms, cfg.bounds.cost_cents, cfg.bounds.max_sub_dispatches,
        cfg.circuit_breaker_threshold ?? 3,
        cfg.standing_brief, opts.now,
        a.name,
      );
      updated.push(a.name);
    }
  }

  for (const r of dbRows) {
    if (!yamlIds.has(r.id) && r.status !== 'retired') {
      db.query("UPDATE long_lived_agents SET status='retired', retired_at=?, updated_at=? WHERE id=?")
        .run(opts.now, opts.now, r.id);
      retired.push(r.id);
    }
  }

  return { inserted, updated, retired };
}
