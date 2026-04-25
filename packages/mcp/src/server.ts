import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ObserveInputShape, observeHandler } from './tools/observe.js';
import { RecallInputShape, recallHandler } from './tools/recall.js';
import { SessionEndInputShape, sessionEndHandler } from './tools/session-end.js';
import type { DaemonClient } from './daemon-client.js';

export function buildServer(opts: { daemon: DaemonClient }): McpServer {
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  server.registerTool(
    'memory.observe',
    { description: 'Record an observation into Penumbra T0.', inputSchema: ObserveInputShape },
    observeHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.recall',
    { description: 'Retrieve top-K memories (T1+T2) by semantic similarity.', inputSchema: RecallInputShape },
    recallHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'session.end',
    { description: 'Trigger a synchronous T1 rollup for the named session. Returns the rollup_id, or null if there was nothing to roll up (already rolled up or no events).', inputSchema: SessionEndInputShape },
    sessionEndHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  return server;
}
