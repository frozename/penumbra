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
  envAllowlist?: Set<string>;
}

function envelope(body: object, isError = false) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(body),
    }],
    ...(isError ? { isError: true } : {}),
  };
}

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

  const tools = opts.envAllowlist
    ? federationResponse.tools.filter((tool) => opts.envAllowlist!.has(tool.name))
    : federationResponse.tools;

  const registered: VirtualToolDef[] = [];
  for (const tool of tools) {
    try {
      opts.server.registerTool(
        tool.name,
        {
          description: tool.description ?? `(federated via daemon) ${tool.name}`,
          // The McpServer SDK expects a Zod raw shape (Record<string, ZodType>),
          // not the JSON Schema returned by the upstream hosted MCP server.
          // Real arg validation happens at the hosted server when the daemon
          // forwards the call, so an empty shape here is safe and lets the
          // tool accept any object payload.
          inputSchema: {},
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
      // Skip it and continue so static + remaining federated tools still load.
      console.warn(
        '[federation] failed to register tool',
        tool.name,
        '-',
        String((err as Error)?.message ?? err),
      );
    }
  }

  return registered;
}
