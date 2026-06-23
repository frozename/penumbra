import type { McpPoolLike } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { randomUUID } from "node:crypto";

import { globToRegExp } from "./action-gate.js";

export interface ActionGateCallbacksDeps {
  db: Database;
  mcpPool?: McpPoolLike;
  log: {
    warn?: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
  };
}

export interface ActionGateCallbacks {
  executeTool: (tool: string, args: unknown, _meta?: Record<string, unknown>) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
}

type SnapshotFailureReason =
  | "bad_allowlist"
  | "no_snapshot_tool_configured"
  | "invalid_snapshot_tool"
  | "snapshot_tool_not_in_allowlist"
  | "no_pool";

type LogActionGateSnapshotSkip = (obj: unknown, msg: string) => void;

function parseStringArrayJson(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("not_array");
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function extractSnapshotId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const snapshotId = record.snapshot_id;
  if (typeof snapshotId === "string") {
    return snapshotId;
  }
  const id = record.id;
  return typeof id === "string" ? id : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotSkipSentinel(reason: SnapshotFailureReason): string {
  if (reason === "snapshot_tool_not_in_allowlist") {
    return "snapshot_skipped_not_in_allowlist";
  }
  return `snapshot_skipped_${reason}`;
}

function rejectOrSkipSnapshot(input: {
  requireSnapshot: boolean;
  thrownReason: string;
  skipReason: SnapshotFailureReason;
  agentId: string;
  logError?: LogActionGateSnapshotSkip;
}): string {
  if (input.requireSnapshot) {
    throw new Error(input.thrownReason);
  }
  input.logError?.(
    { agent_id: input.agentId, tier2_fail_open: true, reason: input.skipReason },
    "action-gate-snapshot-skipped",
  );
  return snapshotSkipSentinel(input.skipReason);
}

function parseSnapshotTool(snapshotTool: string): { server: string; toolName: string } | undefined {
  const colon = snapshotTool.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return { server: snapshotTool.slice(0, colon), toolName: snapshotTool.slice(colon + 1) };
}

/**
 * Build the executeTool + takeSnapshot callbacks for createActionGate.
 *
 * Snapshot behavior is configured per long-lived agent via
 * `snapshot_tool` and `require_snapshot` on `long_lived_config`.
 *
 * Default (require_snapshot=false): fail-open. If the snapshot tool is
 * absent, malformed, blocked by the allowlist, the pool is unavailable, or
 * the allowlist row is itself unparseable, takeSnapshot returns a sentinel
 * string and Tier 2 calls proceed without a rollback point.
 *
 * Opt-in (require_snapshot=true): fail-closed. Every fail-open path above
 * instead throws, so the action-gate audits `snapshot_failed` and rejects
 * the Tier 2 call. Schema-level invariant enforces that snapshot_tool is
 * set whenever require_snapshot is true, but the runtime guards still apply
 * because the DB row could be tampered with after config load.
 */
export function buildActionGateCallbacks(deps: ActionGateCallbacksDeps): ActionGateCallbacks {
  const logError = deps.log.error ?? deps.log.warn;
  return {
    executeTool: async (tool, args, _meta): Promise<unknown> => {
      const colon = tool.indexOf(":");
      if (colon <= 0) {
        throw new Error("invalid_tool_id");
      }
      const server = tool.slice(0, colon);
      const toolName = tool.slice(colon + 1);
      if (!deps.mcpPool) {
        throw new Error("mcp_pool_unavailable");
      }
      if (_meta) {
        return await deps.mcpPool.callTool(server, toolName, args, { _meta });
      }
      return await deps.mcpPool.callTool(server, toolName, args);
    },
    takeSnapshot: async (agent_id): Promise<string> => {
      const row = deps.db
        .query<
          { mcp_allowlist_json: string; snapshot_tool: string | null; require_snapshot: number },
          [string]
        >("SELECT mcp_allowlist_json, snapshot_tool, require_snapshot FROM long_lived_agents WHERE id = ?")
        .get(agent_id);
      if (!row) return "snapshot_skipped_unknown_agent";
      const requireSnapshot = row.require_snapshot === 1;
      let allowlist: string[];
      try {
        allowlist = parseStringArrayJson(row.mcp_allowlist_json);
      } catch {
        return rejectOrSkipSnapshot({
          requireSnapshot,
          thrownReason: "bad_allowlist",
          skipReason: "bad_allowlist",
          agentId: agent_id,
          logError,
        });
      }
      const snapshotTool = row.snapshot_tool?.trim() ?? "";
      if (!snapshotTool) {
        return rejectOrSkipSnapshot({
          requireSnapshot,
          thrownReason: "snapshot_tool_not_configured",
          skipReason: "no_snapshot_tool_configured",
          agentId: agent_id,
          logError,
        });
      }
      const parsedTool = parseSnapshotTool(snapshotTool);
      if (!parsedTool?.toolName) {
        return rejectOrSkipSnapshot({
          requireSnapshot,
          thrownReason: "invalid_snapshot_tool",
          skipReason: "invalid_snapshot_tool",
          agentId: agent_id,
          logError,
        });
      }
      const matchers = allowlist.map((glob) => globToRegExp(glob));
      const canSnapshot = matchers.some((re) => re.test(snapshotTool));
      if (!canSnapshot) {
        return rejectOrSkipSnapshot({
          requireSnapshot,
          thrownReason: "snapshot_tool_not_in_allowlist",
          skipReason: "snapshot_tool_not_in_allowlist",
          agentId: agent_id,
          logError,
        });
      }
      if (!deps.mcpPool) {
        return rejectOrSkipSnapshot({
          requireSnapshot,
          thrownReason: "mcp_pool_unavailable",
          skipReason: "no_pool",
          agentId: agent_id,
          logError,
        });
      }
      try {
        const result = await deps.mcpPool.callTool(parsedTool.server, parsedTool.toolName, {});
        const extracted = extractSnapshotId(result);
        return typeof extracted === "string" ? extracted : `snapshot-${randomUUID()}`;
      } catch (err) {
        deps.log.warn?.(
          { agent_id, err: errorMessage(err) },
          "action-gate-takeSnapshot-call-failed",
        );
        throw err;
      }
    },
  };
}
