import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from './daemon-client.js';
import { TOOL_REGISTRY } from './tools/registry.js';

export function buildServer(opts: { daemon: DaemonClient; shellEnabled?: boolean }): McpServer {
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
    server.registerTool(
      name,
      def.descriptor as Parameters<typeof server.registerTool>[1],
      def.makeHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
  return server;
}
