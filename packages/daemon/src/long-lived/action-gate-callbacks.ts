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
 * Snapshot behavior is configured per long-lived agent via
 * `snapshot_tool` and `require_snapshot` on `long_lived_config`.
 *
 * V1 is fail-open: if a snapshot tool is absent, malformed, or not allowed,
 * Tier 2 calls continue with a sentinel snapshot id.
 * V2 is fail-closed when `require_snapshot: true`: the same configuration
 * problems reject the action gate instead of proceeding without a snapshot.
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
      const row = deps.db.query<{ mcp_allowlist_json: string; snapshot_tool: string | null; require_snapshot: number }, [string]>(
        'SELECT mcp_allowlist_json, snapshot_tool, require_snapshot FROM long_lived_agents WHERE id = ?',
      ).get(agent_id);
      if (!row) return 'snapshot_skipped_unknown_agent';
      const requireSnapshot = row.require_snapshot === 1;
      let allowlist: string[];
      try {
        allowlist = JSON.parse(row.mcp_allowlist_json);
        if (!Array.isArray(allowlist)) throw new Error('not_array');
      } catch {
        logError?.({ agent_id, tier2_fail_open: true, reason: 'bad_allowlist' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_bad_allowlist';
      }
      const snapshotTool = row.snapshot_tool?.trim() ?? '';
      if (!snapshotTool) {
        if (requireSnapshot) throw new Error('snapshot_tool_not_configured');
        logError?.({ agent_id, tier2_fail_open: true, reason: 'no_snapshot_tool_configured' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_no_snapshot_tool_configured';
      }
      const colon = snapshotTool.indexOf(':');
      const server = colon > 0 ? snapshotTool.slice(0, colon) : '';
      const toolName = colon > 0 ? snapshotTool.slice(colon + 1) : '';
      if (!server || !toolName) {
        if (requireSnapshot) throw new Error('invalid_snapshot_tool');
        logError?.({ agent_id, tier2_fail_open: true, reason: 'invalid_snapshot_tool' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_invalid_snapshot_tool';
      }
      const stringEntries = allowlist.filter((e): e is string => typeof e === 'string');
      const matchers = stringEntries.map((glob) => globToRegExp(glob));
      const canSnapshot = matchers.some((re) => re.test(snapshotTool));
      if (!canSnapshot) {
        if (requireSnapshot) throw new Error('snapshot_tool_not_in_allowlist');
        logError?.({ agent_id, tier2_fail_open: true, reason: 'snapshot_tool_not_in_allowlist' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_not_in_allowlist';
      }
      if (!deps.mcpPool) {
        if (requireSnapshot) throw new Error('mcp_pool_unavailable');
        logError?.({ agent_id, tier2_fail_open: true, reason: 'no_pool' }, 'action-gate-snapshot-skipped');
        return 'snapshot_skipped_no_pool';
      }
      try {
        const result = await deps.mcpPool.callTool(server, toolName, {});
        const extracted = (result as any)?.snapshot_id ?? (result as any)?.id;
        return typeof extracted === 'string' ? extracted : `snapshot-${randomUUID()}`;
      } catch (err) {
        deps.log.warn?.({ agent_id, err: String((err as Error)?.message ?? err) }, 'action-gate-takeSnapshot-call-failed');
        throw err;
      }
    },
  };
}
