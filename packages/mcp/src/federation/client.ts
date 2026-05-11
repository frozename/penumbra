import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from '../daemon-client.js';
import { getLongLivedRuntimeContext } from '../long-lived-context.js';

interface VirtualToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface RegisterFederatedToolsOpts {
  server: McpServer;
  daemon: DaemonClient;
  agentId?: string;
  tickId?: string;
}

const QUEUED_INSTRUCTION =
  'This action requires operator approval. Record an open_thread referencing pending_action_id; do not retry.';

export async function registerFederatedTools(opts: RegisterFederatedToolsOpts): Promise<VirtualToolDef[]> {
  const ctx = getLongLivedRuntimeContext();
  const agentId = opts.agentId ?? ctx.running_agent_id;
  const tickId = opts.tickId ?? ctx.running_tick_id;
  if (!agentId || !tickId) return [];

  let federationResponse: { tools: VirtualToolDef[] };
  try {
    federationResponse = await opts.daemon.getFederationTools(agentId);
  } catch (err) {
    console.warn('[federation] failed to fetch federation tools:', String((err as Error)?.message ?? err));
    return [];
  }

  for (const tool of federationResponse.tools) {
    opts.server.registerTool(
      tool.name,
      {
        description: tool.description ?? `(federated via daemon) ${tool.name}`,
        inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
      } as any,
      (async (args: unknown) => {
        try {
          const result = await opts.daemon.mcpCall({
            agent_id: agentId,
            tick_id: tickId,
            tool: tool.name,
            args: args ?? {},
          });
          const body = result as { action_status?: string; result?: unknown; pending_action_id?: string; error?: string; details?: unknown; message?: string };
          if (body.action_status === 'executed') {
            return body.result;
          }
          if (body.action_status === 'queued') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  action_status: 'queued',
                  pending_action_id: body.pending_action_id,
                  message: body.message ?? QUEUED_INSTRUCTION,
                }),
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                action_status: body.action_status ?? 'rejected',
                error: body.error ?? 'unknown_error',
                details: body.details,
              }),
            }],
            isError: true,
          };
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                action_status: 'rejected',
                error: 'mcp_unavailable',
                details: String((err as Error)?.message ?? err),
              }),
            }],
            isError: true,
          };
        }
      }) as any,
    );
  }

  return federationResponse.tools;
}
