import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { extractActionTarget } from './target-extractors.js';

const BASELINE_TIERS: Array<{ match: RegExp; tier: 1 | 2 | 3 }> = [
  { match: /^ha:state\./, tier: 1 },
  { match: /^ha:(light|switch|climate)\./, tier: 1 },
  { match: /^ha:script\.run$/, tier: 1 },
  { match: /^ha:snapshot\.(create|list)$/, tier: 1 },
  { match: /^ha:dashboard\./, tier: 2 },
  { match: /^ha:automation\.(set|delete)$/, tier: 2 },
  { match: /^ha:snapshot\.restore$/, tier: 2 },
  { match: /^ha:integration\./, tier: 3 },
];

function baselineTier(tool: string): 1 | 2 | 3 {
  for (const rule of BASELINE_TIERS) {
    if (rule.match.test(tool)) return rule.tier;
  }
  return 1;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function classifyTier(input: {
  tool: string;
  target: string;
  agentGlobs: readonly string[];
}): 1 | 2 | 3 {
  const targetVariants = [input.target];
  const dotIndex = input.target.indexOf('.');
  if (dotIndex >= 0 && dotIndex + 1 < input.target.length) {
    targetVariants.push(input.target.slice(dotIndex + 1));
  }
  for (const glob of input.agentGlobs) {
    const matcher = globToRegExp(glob);
    if (matcher.test(input.tool)) return 3;
    for (const target of targetVariants) {
      if (matcher.test(`${input.tool}:${target}`)) return 3;
      if (matcher.test(target)) return 3;
    }
  }
  return baselineTier(input.tool);
}

export function cooldownMsFor(tool: string, overrides: Record<string, number>): number {
  for (const [glob, ms] of Object.entries(overrides)) {
    if (globToRegExp(glob).test(tool)) return ms;
  }
  return 600_000;
}

export interface ActionGate {
  handleCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    _meta?: Record<string, unknown>;
    pending_action_id?: string;
  }): Promise<
    | { kind: 'executed'; result: unknown; tier: 1 | 2 | 3; snapshot_id?: string }
    | { kind: 'rejected'; error: string; details?: unknown }
    | { kind: 'queued'; pending_action_id: string }
  >;
}

export interface ActionGateDeps {
  db: Database;
  executeTool: (tool: string, args: unknown, _meta?: Record<string, unknown>) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
  now: () => number;
}

export function createActionGate(deps: ActionGateDeps): ActionGate {
  return {
    async handleCall({ agent_id, tick_id, tool, args, _meta, pending_action_id }) {
      let effectiveMeta = _meta;
      if (!effectiveMeta && pending_action_id) {
        const pendingMeta = deps.db.query<{ meta_json: string | null }, [string]>(
          'SELECT meta_json FROM long_lived_pending_actions WHERE id = ?',
        ).get(pending_action_id);
        if (pendingMeta?.meta_json) {
          try {
            const parsedMeta = JSON.parse(pendingMeta.meta_json) as unknown;
            if (parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) {
              effectiveMeta = parsedMeta as Record<string, unknown>;
            }
          } catch {
            // Ignore malformed stored metadata and continue without _meta.
          }
        }
      }
      const agent = deps.db.query<{
        mcp_allowlist_json: string;
        approval_required_globs_json: string;
        cooldown_overrides_json: string;
      }, [string]>(
        'SELECT mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json FROM long_lived_agents WHERE id=?',
      ).get(agent_id);
      if (!agent) return { kind: 'rejected', error: 'agent_not_found' };

      const allowlist: unknown = JSON.parse(agent.mcp_allowlist_json);
      const allowed = Array.isArray(allowlist)
        && allowlist
          .filter((entry): entry is string => typeof entry === 'string')
          .some((glob) => globToRegExp(glob).test(tool));
      const target = extractActionTarget(tool, args);
      if (!allowed) {
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
          VALUES (?, ?, ?, ?, ?, 'gate_failed', 'not_in_allowlist', ?)`)
          .run(agent_id, tick_id, pending_action_id ?? null, tool, '', deps.now());
        return { kind: 'rejected', error: 'not_in_allowlist' };
      }

      const globs: string[] = JSON.parse(agent.approval_required_globs_json);
      const baselineTier = classifyTier({ tool, target, agentGlobs: [] });
      let tier = classifyTier({ tool, target, agentGlobs: globs });
      if (pending_action_id) {
        tier = tier === 3 ? 1 : tier;
        if (baselineTier === 2) tier = 2;
      }

      if (tier === 3) {
        const id = randomUUID();
        deps.db.query(`INSERT INTO long_lived_pending_actions
          (id, agent_id, tick_id, action_kind, action_target, payload_json, meta_json, status, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(id, agent_id, tick_id, tool, target, JSON.stringify(args), JSON.stringify(effectiveMeta ?? null), deps.now() + 7 * 24 * 60 * 60 * 1000, deps.now());
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', 'approval_required', ?)`)
          .run(agent_id, tick_id, id, tool, target, deps.now());
        return { kind: 'queued', pending_action_id: id };
      }

      if (tier === 2) {
        const overrides: Record<string, number> = JSON.parse(agent.cooldown_overrides_json);
        const cdMs = cooldownMsFor(tool, overrides);
        const existing = deps.db.query<{ cooldown_until: number }, [string, string]>(
          'SELECT until_at AS cooldown_until FROM long_lived_cooldowns WHERE agent_id=? AND action_target=?',
        ).get(agent_id, tool);
        if (existing && existing.cooldown_until > deps.now()) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
            VALUES (?, ?, ?, ?, ?, 'gate_failed', 'cooldown_active', ?)`)
            .run(agent_id, tick_id, pending_action_id ?? null, tool, target, deps.now());
          return { kind: 'rejected', error: 'cooldown_active', details: { expires: existing.cooldown_until } };
        }

        let snapshotId: string;
        try {
          snapshotId = await deps.takeSnapshot(agent_id);
        } catch (err: any) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
            VALUES (?, ?, ?, ?, ?, 'gate_failed', ?, ?)`)
            .run(agent_id, tick_id, pending_action_id ?? null, tool, target, 'snapshot_failed: ' + (err?.message ?? String(err)), deps.now());
          return { kind: 'rejected', error: 'snapshot_failed' };
        }

        let result: unknown;
        try {
          result = await deps.executeTool(tool, args, effectiveMeta);
        } catch (err: any) {
          deps.db.query(`INSERT INTO long_lived_action_audit
            (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
            VALUES (?, ?, ?, ?, ?, 'tool_failed', ?, ?)`)
            .run(agent_id, tick_id, pending_action_id ?? null, tool, target, err?.message ?? String(err), deps.now());
          return { kind: 'rejected', error: 'tool_failed' };
        }

        const until = deps.now() + cdMs;
        deps.db.query(`INSERT OR REPLACE INTO long_lived_cooldowns (agent_id, action_target, until_at, reason, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(agent_id, tool, until, null, deps.now());
        // Historical audit rows may still show legacy colon-form federation tool names; new inserts use the caller's canonical tool string.
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
          VALUES (?, ?, ?, ?, ?, 'executed', ?, ?)`)
          .run(agent_id, tick_id, pending_action_id ?? null, tool, target, snapshotId ? `snapshot:${snapshotId}; cooldown_until:${until}` : `cooldown_until:${until}`, deps.now());

        if (pending_action_id) {
          deps.db.query('UPDATE long_lived_pending_actions SET executed_in_tick_id=? WHERE id=?')
            .run(tick_id, pending_action_id);
        }
        return { kind: 'executed', result, tier: 2, snapshot_id: snapshotId };
      }

      let result: unknown;
      try {
        result = await deps.executeTool(tool, args, effectiveMeta);
      } catch (err: any) {
        deps.db.query(`INSERT INTO long_lived_action_audit
          (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
          VALUES (?, ?, ?, ?, ?, 'tool_failed', ?, ?)`)
          .run(agent_id, tick_id, pending_action_id ?? null, tool, target, err?.message ?? String(err), deps.now());
        return { kind: 'rejected', error: 'tool_failed' };
      }
      deps.db.query(`INSERT INTO long_lived_action_audit
        (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, 'executed', 'tier_1', ?)`)
        .run(agent_id, tick_id, pending_action_id ?? null, tool, target, deps.now());

      if (pending_action_id) {
        deps.db.query('UPDATE long_lived_pending_actions SET executed_in_tick_id=? WHERE id=?')
          .run(tick_id, pending_action_id);
      }
      return { kind: 'executed', result, tier: 1 };
    },
  };
}
