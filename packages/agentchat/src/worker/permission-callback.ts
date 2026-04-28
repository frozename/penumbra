import type { PermissionDecision, ToolCallContext } from '../sdk/adapter.js';
import type { PermissionDaemonClient } from './permission-daemon-client.js';
import { matchAllowlist } from './allowlist-matcher.js';

export interface PermissionCallbackV2Opts {
  trustMode: 'all' | 'config';
  allowedTools: readonly string[];
  handoffId: string;
  conversationId: string;
  agentName: string;
  ttlSeconds: number;
  daemonClient: Pick<PermissionDaemonClient, 'requestPermission'>;
  perDispatchAllowlist: Set<string>;
}

export type PermissionCallback = (toolCall: ToolCallContext) => Promise<PermissionDecision>;

/** v1 form: trust-mode-only blanket decision. Kept for backward compat with callers
 *  that don't yet pass the v2 opts object. */
export function createPermissionCallback(trustMode?: 'all' | 'config'): PermissionCallback;
/** v2 form: allowlist + daemon-mediated operator pause. */
export function createPermissionCallback(opts: PermissionCallbackV2Opts): PermissionCallback;
export function createPermissionCallback(arg?: 'all' | 'config' | PermissionCallbackV2Opts): PermissionCallback {
  if (arg === undefined || typeof arg === 'string') {
    const trustMode = arg ?? 'all';
    return async (_toolCall: ToolCallContext): Promise<PermissionDecision> => {
      return trustMode === 'all' ? 'approve' : 'reject';
    };
  }

  const opts = arg;
  return async (toolCall: ToolCallContext): Promise<PermissionDecision> => {
    if (opts.trustMode === 'all') return 'approve';
    if (matchAllowlist(opts.allowedTools, opts.perDispatchAllowlist, toolCall.toolName)) return 'approve';
    try {
      const result = await opts.daemonClient.requestPermission({
        parent_handoff_id: opts.handoffId,
        conversation_id: opts.conversationId,
        agent_name: opts.agentName,
        tool_name: toolCall.toolName,
        raw_input: toolCall.rawInput,
        ttl_seconds: opts.ttlSeconds,
      });
      if (result.decision === 'approve' && result.remember === 'this_dispatch') {
        opts.perDispatchAllowlist.add(toolCall.toolName);
      }
      return result.decision;
    } catch {
      return 'reject';
    }
  };
}
