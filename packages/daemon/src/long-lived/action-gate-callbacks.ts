import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Services } from '@penumbra/core';
import { globToRegExp } from './action-gate.js';

type McpPoolLike = NonNullable<Services['mcpPool']>;

export interface ActionGateCallbacksDeps {
  db: Database;
  mcpPool?: McpPoolLike;
  log: {
    warn?: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
  };
}

export interface ActionGateCallbacks {
  executeTool: (tool: string, args: unknown) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
}

/**
 * Build the executeTool + takeSnapshot callbacks for createActionGate.
 *
 * V1 NOTE on snapshot semantics (intentional, see plan
 * `docs/superpowers/plans/2026-05-11-action-gate-federation.md`):
 * If the agent's allowlist does NOT contain a snapshot-capable tool
 * (currently hardcoded to `ha:ha_backup_create`), takeSnapshot returns a
 * sentinel id like `snapshot_skipped_no_backup_tool` and Tier 2 mutations
 * proceed WITHOUT a rollback point. This is fail-open by design for V1 —
 * many long-lived agents will have read-only allowlists where Tier 2 calls
 * never fire and snapshots are moot. Operators must inspect
 * `long_lived_action_audit.reason` and the structured log lines below to
 * audit Tier 2 executions that ran without a real snapshot.
 *
 * V2 will introduce an opt-in fail-closed mode (`require_snapshot: true`)
 * on the long_lived_config schema. Don't ship V1 with implicit fail-closed
 * — that breaks pure-read agents whose authors never thought about backups.
 */
export function buildActionGateCallbacks(deps: ActionGateCallbacksDeps): ActionGateCallbacks {
  const logError = deps.log.error ?? deps.log.warn;
  return {
    executeTool: async (tool, args) => {
      const colon = tool.indexOf(':');
      if (colon <= 0) {
        throw new Error('invalid_tool_id');
      }
      const server = tool.slice(0, colon);
      const toolName = tool.slice(colon + 1);
      if (!deps.mcpPool) {
        throw new Error('mcp_pool_unavailable');
      }
      return deps.mcpPool.callTool(server, toolName, args);
    },
    takeSnapshot: async (agent_id) => {
      const row = deps.db.query<{ mcp_allowlist_json: string }, [string]>(
        'SELECT mcp_allowlist_json FROM long_lived_agents WHERE id = ?',
      ).get(agent_id);
      if (!row) return 'snapshot_skipped_unknown_agent';
      let allowlist: string[];
      try {
        allowlist = JSON.parse(row.mcp_allowlist_json);
        if (!Array.isArray(allowlist)) throw new Error('not_array');
      } catch {
        logError?.({ agent_id, tier2_fail_open: true, reason: 'bad_allowlist' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_bad_allowlist';
      }
      const stringEntries = allowlist.filter((e): e is string => typeof e === 'string');
      const matchers = stringEntries.map((glob) => globToRegExp(glob));
      const canSnapshot = matchers.some((re) => re.test('ha:ha_backup_create'));
      if (!canSnapshot) {
        logError?.({ agent_id, tier2_fail_open: true, reason: 'no_backup_tool_in_allowlist' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_no_backup_tool';
      }
      if (!deps.mcpPool) {
        logError?.({ agent_id, tier2_fail_open: true, reason: 'no_pool' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_no_pool';
      }
      try {
        const result = await deps.mcpPool.callTool('ha', 'ha_backup_create', {});
        const extracted = (result as any)?.snapshot_id ?? (result as any)?.id;
        return typeof extracted === 'string' ? extracted : `snapshot-${randomUUID()}`;
      } catch (err) {
        deps.log.warn?.({ agent_id, err: String((err as Error)?.message ?? err) }, 'action-gate-takeSnapshot-call-failed');
        throw err;
      }
    },
  };
}
