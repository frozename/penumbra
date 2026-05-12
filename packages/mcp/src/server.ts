import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from './daemon-client.js';
import { registerFederatedTools } from './federation/client.js';
import { setLongLivedRuntimeContextFromEnv } from './long-lived-context.js';
import { TOOL_REGISTRY } from './tools/registry.js';

export function canonicalToolId(rawId: string): string | null {
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('mcp__')) {
    const parts = trimmed.split('__');
    if (parts.length !== 3) return null;
    const [, serverName, toolName] = parts;
    if (serverName !== 'penumbra') return null;
    if (!toolName || toolName.trim().length === 0) return null;
    return toolName.trim();
  }
  const colon = trimmed.indexOf(':');
  if (colon > 0) return `${trimmed.slice(0, colon)}.${trimmed.slice(colon + 1)}`;
  return trimmed;
}

function parseAllowlist(env: NodeJS.ProcessEnv): Set<string> | null {
  const raw = env.PENUMBRA_MCP_TOOL_ALLOWLIST;
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (tokens.length === 0) return null;
  const names = raw
    .split(',')
    .map((name) => canonicalToolId(name))
    .filter((name): name is string => name !== null);
  return new Set(names);
}

export async function buildServer(opts: { daemon: DaemonClient; shellEnabled?: boolean }): Promise<McpServer> {
  setLongLivedRuntimeContextFromEnv(process.env);
  const allowlist = parseAllowlist(process.env);
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  for (const [rawName, def] of Object.entries(TOOL_REGISTRY)) {
    const name = canonicalToolId(rawName);
    if (!name) continue;
    if (allowlist && !allowlist.has(name)) continue;
    server.registerTool(
      name,
      def.descriptor as Parameters<typeof server.registerTool>[1],
      def.makeHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
  const result = await registerFederatedTools({ server, daemon: opts.daemon, envAllowlist: allowlist });
  console.error(JSON.stringify({
    event: 'federation.registered',
    registered_count: result.registered.length,
    skipped_count: result.skipped.length,
    skipped: result.skipped,
  }));
  return server;
}
