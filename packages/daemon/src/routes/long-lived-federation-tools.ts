import type { Services } from '@penumbra/core';
import { globToRegExp } from '../long-lived/action-gate.js';

import { json } from './_helpers.js';
interface FederationToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface MaybeReadyMcpPool {
  listTools(serverName: string): Promise<FederationToolDescriptor[]>;
  _state?(serverName: string): { initialized?: boolean; initPromise?: Promise<void> } | undefined;
  _readyWaitMs?: number;
}

const FEDERATION_READY_WAIT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFederationReady(pool: MaybeReadyMcpPool, server: string): Promise<void> {
  const state = pool._state?.(server);
  if (!state || state.initialized || !state.initPromise) return;
  await Promise.race([state.initPromise, delay(pool._readyWaitMs ?? FEDERATION_READY_WAIT_MS)]);
}

function parseFederationToolRef(entry: string): { server: string; tool: string } | null {
  // Prefer the first literal separator so legacy `server:tool` and canonical `server.tool` both parse.
  const separator = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('.');
  if (separator <= 0) return null;
  return {
    server: entry.slice(0, separator),
    tool: entry.slice(separator + 1),
  };
}

function parseAllowlist(value: string, services: Services, agentId: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not_array');
    const allowlist: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const parsedEntry = parseFederationToolRef(entry);
      if (!parsedEntry) {
        services.log?.warn?.({ entry, agent_id: agentId }, 'federation-tools-malformed-allowlist-entry');
        continue;
      }
      allowlist.push(`${parsedEntry.server}.${parsedEntry.tool}`);
    }
    return allowlist;
  } catch (err) {
    services.log?.warn?.(
      { err: String((err as Error)?.message ?? err), agent_id: agentId },
      'federation-tools-allowlist-parse-failed',
    );
    return [];
  }
}

export async function longLivedFederationToolsRoute(_req: Request, services: Services, agentId: string): Promise<Response> {
  const row = services.db.query<{ mcp_allowlist_json: string }, [string]>(
    'SELECT mcp_allowlist_json FROM long_lived_agents WHERE id = ?',
  ).get(agentId);
  if (!row) return json({ error: 'agent_not_found' }, 404);

  const allowlist = parseAllowlist(row.mcp_allowlist_json, services, agentId);
  if (!services.mcpPool) {
    return json({ tools: [] });
  }

  const serverNames = new Set<string>();
  for (const entry of allowlist) {
    const parsedEntry = parseFederationToolRef(entry);
    if (!parsedEntry) continue;
    serverNames.add(parsedEntry.server);
  }
  serverNames.delete('penumbra');
  const matchers = allowlist.map((glob) => globToRegExp(glob));

  const tools: FederationToolDescriptor[] = [];
  for (const server of serverNames) {
    let serverTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    try {
      await waitForFederationReady(services.mcpPool as MaybeReadyMcpPool, server);
      serverTools = await services.mcpPool.listTools(server);
    } catch (err) {
      services.log.warn(
        { err: String((err as Error)?.message ?? err), server, agent_id: agentId },
        'federation-tools-listTools-failed',
      );
      continue;
    }

    for (const tool of serverTools) {
      const canonical = `${server}.${tool.name}`;
      if (!matchers.some((re) => re.test(canonical))) continue;
      tools.push({
        name: canonical,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return json({ tools });
}
