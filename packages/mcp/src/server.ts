import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from './daemon-client.js';
import { setLongLivedRuntimeContextFromEnv } from './long-lived-context.js';
import { TOOL_REGISTRY } from './tools/registry.js';

function parseAllowlist(env: NodeJS.ProcessEnv): Set<string> | null {
  const raw = env.PENUMBRA_MCP_TOOL_ALLOWLIST;
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

export function buildServer(opts: { daemon: DaemonClient; shellEnabled?: boolean }): McpServer {
  setLongLivedRuntimeContextFromEnv(process.env);
  const allowlist = parseAllowlist(process.env);
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
    if (allowlist && !allowlist.has(name)) continue;
    server.registerTool(
      name,
      def.descriptor as Parameters<typeof server.registerTool>[1],
      def.makeHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
  return server;
}
