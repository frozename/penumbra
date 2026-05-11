import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { McpPoolLike } from '../../../core/src/services.js';
import { globToRegExp } from './action-gate.js';

export interface ActionGateCallbacksDeps {
  db: Database;
  mcpPool?: McpPoolLike;
  log: { warn: (obj: unknown, msg: string) => void };
}

export interface ActionGateCallbacks {
  executeTool: (tool: string, args: unknown) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
}

export function buildActionGateCallbacks(deps: ActionGateCallbacksDeps): ActionGateCallbacks {
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
        deps.log.warn({ agent_id }, 'action-gate-takeSnapshot-bad-allowlist');
        return 'snapshot_skipped_bad_allowlist';
      }
      const matchers = allowlist.map((glob) => globToRegExp(glob));
      const canSnapshot = matchers.some((re) => re.test('ha:ha_backup_create'));
      if (!canSnapshot) {
        deps.log.warn({ agent_id }, 'action-gate-takeSnapshot-no-backup-tool-in-allowlist');
        return 'snapshot_skipped_no_backup_tool';
      }
      if (!deps.mcpPool) {
        deps.log.warn({ agent_id }, 'action-gate-takeSnapshot-no-pool');
        return 'snapshot_skipped_no_pool';
      }
      try {
        const result = await deps.mcpPool.callTool('ha', 'ha_backup_create', {});
        const extracted = (result as any)?.snapshot_id ?? (result as any)?.id;
        return typeof extracted === 'string' ? extracted : `snapshot-${randomUUID()}`;
      } catch (err) {
        deps.log.warn({ agent_id, err: String((err as Error)?.message ?? err) }, 'action-gate-takeSnapshot-call-failed');
        throw err;
      }
    },
  };
}
