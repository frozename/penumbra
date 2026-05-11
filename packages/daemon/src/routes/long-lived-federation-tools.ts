import type { Services } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FederationToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function longLivedFederationToolsRoute(_req: Request, services: Services, agentId: string): Promise<Response> {
  const row = services.db.query<{ mcp_allowlist_json: string }, [string]>(
    'SELECT mcp_allowlist_json FROM long_lived_agents WHERE id = ?',
  ).get(agentId);
  if (!row) return json({ error: 'agent_not_found' }, 404);

  const allowlist = parseJsonArray(row.mcp_allowlist_json);
  if (!services.mcpPool) {
    return json({ tools: [] });
  }

  const serverNames = new Set<string>();
  for (const entry of allowlist) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;
    serverNames.add(entry.slice(0, colon));
  }

  const tools: FederationToolDescriptor[] = [];
  for (const server of serverNames) {
    let serverTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    try {
      serverTools = await services.mcpPool.listTools(server);
    } catch (err) {
      services.log.warn(
        { err: String((err as Error)?.message ?? err), server, agent_id: agentId },
        'federation-tools-listTools-failed',
      );
      continue;
    }

    for (const tool of serverTools) {
      const canonical = `${server}:${tool.name}`;
      if (!allowlist.includes(canonical)) continue;
      tools.push({
        name: canonical,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return json({ tools });
}
