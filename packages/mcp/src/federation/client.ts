import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { getLongLivedRuntimeContext } from '../long-lived-context.js';

interface VirtualToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface SkippedTool {
  name: string;
  reason: string;
}

export interface RegisterFederatedToolsResult {
  registered: VirtualToolDef[];
  skipped: SkippedTool[];
}

interface RegisterFederatedToolsOpts {
  server: McpServer;
  daemon: DaemonClient;
  agentId?: string;
  tickId?: string;
  envAllowlist?: Set<string>;
}

// Passthrough object schema: accepts any keys and preserves them through
// SDK input validation, so tool-call args reach the handler intact. An
// empty raw shape ({}) builds a STRICT empty schema that strips every
// unknown key — the inverse of what we want for a federated forwarder.
const PASSTHROUGH_INPUT_SCHEMA = z.object({}).catchall(z.unknown());

function envelope(body: object, isError = false) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(body),
    }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function registerFederatedTools(opts: RegisterFederatedToolsOpts): Promise<RegisterFederatedToolsResult> {
  const ctx = getLongLivedRuntimeContext();
  const agentId = opts.agentId ?? ctx.running_agent_id;
  const tickId = opts.tickId ?? ctx.running_tick_id;
  if (!agentId || !tickId) return { registered: [], skipped: [] };

  let federationResponse: { tools: VirtualToolDef[] };
  try {
    federationResponse = await opts.daemon.getFederationTools(agentId);
  } catch (err) {
    console.warn('[federation] failed to fetch federation tools:', String((err as Error)?.message ?? err));
    return { registered: [], skipped: [] };
  }

  const tools = opts.envAllowlist
    ? federationResponse.tools.filter((tool) => opts.envAllowlist!.has(tool.name))
    : federationResponse.tools;

  const registered: VirtualToolDef[] = [];
  const skipped: SkippedTool[] = [];
  for (const tool of tools) {
    try {
      opts.server.registerTool(
        tool.name,
        {
          description: tool.description ?? `(federated via daemon) ${tool.name}`,
          inputSchema: PASSTHROUGH_INPUT_SCHEMA,
        } as any,
        (async (args: unknown) => {
          try {
            const wireToolName = tool.name.replace(/^([^.:]+)\./, '$1:');
            const result = await opts.daemon.mcpCall({
              agent_id: agentId,
              tick_id: tickId,
              tool: wireToolName,
              args: args ?? {},
            });
            const body = result as { action_status?: string; result?: unknown; pending_action_id?: string; error?: string; details?: unknown; message?: string };
            if (body.action_status === 'executed') {
              return body.result;
            }
            if (body.action_status === 'queued') {
              return envelope({
                action_status: 'queued',
                pending_action_id: body.pending_action_id,
                message: body.message,
              });
            }
            return envelope({
              action_status: body.action_status ?? 'rejected',
              error: body.error ?? 'unknown_error',
              details: body.details,
            }, true);
          } catch (err) {
            return envelope({
              action_status: 'rejected',
              error: 'mcp_unavailable',
              details: String((err as Error)?.message ?? err),
            }, true);
          }
        }) as any,
      );
      registered.push(tool);
    } catch (err) {
      // One bad federated tool must not crash the whole MCP server boot.
      // Surface the skip both in logs and in the return shape so callers
      // can report degraded-federation startup state.
      const reason = String((err as Error)?.message ?? err);
      skipped.push({ name: tool.name, reason });
      console.warn(`[federation] failed to register tool name=${tool.name} reason=${reason}`);
    }
  }

  return { registered, skipped };
}
