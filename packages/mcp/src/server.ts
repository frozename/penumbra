import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ObserveInputShape, observeHandler } from './tools/observe.js';
import { RecallInputShape, recallHandler } from './tools/recall.js';
import { SessionEndInputShape, sessionEndHandler } from './tools/session-end.js';
import { ListHandoffsInputShape, listHandoffsHandler } from './tools/handoff-list.js';
import { ApproveHandoffInputShape, approveHandoffHandler } from './tools/handoff-approve.js';
import { HandoffGetInputShape, handoffGetHandler } from './tools/handoff-get.js';
import { ChainStartInputShape, chainStartHandler } from './tools/chain-start.js';
import { ChainHistoryInputShape, chainHistoryHandler } from './tools/chain-history.js';
import { ChainGetResponseInputShape, chainGetResponseHandler } from './tools/chain-get-response.js';
import { ChainWaitInputShape, chainWaitHandler } from './tools/chain-wait.js';
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
  server.registerTool(
    'handoff.list_pending',
    { description: 'List pending agent handoffs awaiting approval.', inputSchema: ListHandoffsInputShape },
    listHandoffsHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'handoff.approve',
    { description: 'Approve, redirect, or reject a pending handoff.', inputSchema: ApproveHandoffInputShape },
    approveHandoffHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'handoff.get',
    { description: 'Returns the current state of a single handoff.', inputSchema: HandoffGetInputShape },
    handoffGetHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.start',
    {
      description:
        'Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches the chain headlessly. Poll handoff.list_pending to monitor.',
      inputSchema: ChainStartInputShape,
    },
    chainStartHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.wait',
    {
      description: 'Block until the conversation reaches a terminal state (completed or failed) or timeout.',
      inputSchema: ChainWaitInputShape,
    },
    chainWaitHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.history',
    {
      description: 'Returns the chain-terminated events for a given conversation_id.',
      inputSchema: ChainHistoryInputShape,
    },
    chainHistoryHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.get_response',
    {
      description: 'Returns the agent responses for a given conversation_id. which="final" returns the most recent response. which="all" returns all responses chronologically.',
      inputSchema: ChainGetResponseInputShape,
    },
    chainGetResponseHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  return server;
}
