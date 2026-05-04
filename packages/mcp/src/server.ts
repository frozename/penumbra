import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ObserveInputShape, observeHandler } from './tools/observe.js';
import { RecallInputShape, recallHandler } from './tools/recall.js';
import { SearchInputShape, searchHandler } from './tools/search.js';
import { TimelineInputShape, timelineHandler } from './tools/timeline.js';
import { GetObservationsInputShape, getObservationsHandler } from './tools/get-observations.js';
import { CorpusBuildInputShape, corpusBuildHandler } from './tools/corpus-build.js';
import { CorpusQueryInputShape, corpusQueryHandler } from './tools/corpus-query.js';
import { CorpusListInputShape, corpusListHandler } from './tools/corpus-list.js';
import { RecallStatusInputShape, recallStatusHandler } from './tools/recall-status.js';
import { SessionEndInputShape, sessionEndHandler } from './tools/session-end.js';
import { CostRecentInputShape, costRecentHandler } from './tools/cost-recent.js';
import { CostQuotaStatusInputShape, costQuotaStatusHandler } from './tools/cost-quota-status.js';
import { AgentRankInputShape, agentRankHandler } from './tools/agent-rank.js';
import { ListHandoffsInputShape, listHandoffsHandler } from './tools/handoff-list.js';
import { ApproveHandoffInputShape, approveHandoffHandler } from './tools/handoff-approve.js';
import { HandoffGetInputShape, handoffGetHandler } from './tools/handoff-get.js';
import { DispatchAuditInputShape, dispatchAuditHandler } from './tools/dispatch-audit.js';
import { DispatchTimelineInputShape, dispatchTimelineHandler } from './tools/dispatch-timeline.js';
import { ChainStatusInputShape, chainStatusHandler } from './tools/chain-status.js';
import { ChainStartInputShape, chainStartHandler } from './tools/chain-start.js';
import { ChainHistoryInputShape, chainHistoryHandler } from './tools/chain-history.js';
import { ChainGetMessagesInputShape, chainGetMessagesHandler } from './tools/chain-get-messages.js';
import { ChainGetResponseInputShape, chainGetResponseHandler } from './tools/chain-get-response.js';
import { ChainListAgentsInputShape, chainListAgentsHandler } from './tools/chain-list-agents.js';
import { ChainCancelInputShape, chainCancelHandler } from './tools/chain-cancel.js';
import { ChainWaitInputShape, chainWaitHandler } from './tools/chain-wait.js';
import { WorktreeListInputShape, worktreeListHandler } from './tools/worktree-list.js';
import { WorktreeInspectInputShape, worktreeInspectHandler } from './tools/worktree-inspect.js';
import { WorktreeCleanupInputShape, worktreeCleanupHandler } from './tools/worktree-cleanup.js';
import { FsGlobInputShape, fsGlobHandler } from './tools/fs-glob.js';
import { FsGrepInputShape, fsGrepHandler } from './tools/fs-grep.js';
import { PermissionListPendingInputShape, permissionListPendingHandler } from './tools/permission-list-pending.js';
import { PermissionGetInputShape, permissionGetHandler } from './tools/permission-get.js';
import { PermissionApproveInputShape, permissionApproveHandler } from './tools/permission-approve.js';
import {
  DAEMON_RELOAD_CONFIG_DESCRIPTION,
  DaemonReloadConfigInputShape,
  daemonReloadConfigHandler,
} from './tools/daemon-reload-config.js';
import { ShellRunInputShape, shellRunHandler } from './tools/shell-run.js';
import { ShellCloseInputShape, shellCloseHandler } from './tools/shell-close.js';
import { ShellListInputShape, shellListHandler } from './tools/shell-list.js';
import type { DaemonClient } from './daemon-client.js';

export function buildServer(opts: { daemon: DaemonClient; shellEnabled?: boolean }): McpServer {
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
    'memory.search',
    {
      description:
        'Step 1 of 3-layer recall: compact index of memory hits (id + title + snippet + score) over t1_fts/t2_fts with metadata filters. Cheap to scan; pair with memory.timeline + memory.get_observations.',
      inputSchema: SearchInputShape,
    },
    searchHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.timeline',
    {
      description:
        'Step 2 of 3-layer recall: chronological neighbors around an anchor t2 memory. Use to see what was happening just before/after a hit.',
      inputSchema: TimelineInputShape,
    },
    timelineHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.get_observations',
    {
      description:
        'Step 3 of 3-layer recall: hydrate full bodies for IDs returned by memory.search or memory.timeline. Always batch — do not call once per ID.',
      inputSchema: GetObservationsInputShape,
    },
    getObservationsHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.corpus_build',
    {
      description:
        'Build (or rebuild by name) a knowledge corpus: a named, persisted bundle of t2 observations matching a metadata filter (project_id / obs_type / concept / file_path / date range). Use as a topical RAG slice that survives across recalls.',
      inputSchema: CorpusBuildInputShape,
    },
    corpusBuildHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.corpus_query',
    {
      description:
        'Vector-rerank a query against members of a named corpus only. Returns the same hit shape as memory.search but constrained to the corpus.',
      inputSchema: CorpusQueryInputShape,
    },
    corpusQueryHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.corpus_list',
    {
      description: 'List all knowledge corpora with their member counts and creation timestamps.',
      inputSchema: CorpusListInputShape,
    },
    corpusListHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.status',
    {
      description:
        'Recall corpus health snapshot: tier counts (t0/t1/t2), t2 obs_type/severity histograms, t1 promotion backlog (unpromoted + failed), corpora count, and last recall_audit timestamp.',
      inputSchema: RecallStatusInputShape,
    },
    recallStatusHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'cost.recent',
    {
      description: 'Returns the recent cost ledger summary (totals + by_provider) over a 24h-default window.',
      inputSchema: CostRecentInputShape,
    },
    costRecentHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'cost.quota_status',
    {
      description: 'Returns per-provider quota status: used vs configured 24h-rolling cost/token budgets.',
      inputSchema: CostQuotaStatusInputShape,
    },
    costQuotaStatusHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'agent.rank',
    {
      description: 'Rank agents for a task type using captured dispatch outcome, cost, and latency data.',
      inputSchema: AgentRankInputShape,
    },
    agentRankHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
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
    'dispatch.timeline',
    {
      description: 'Returns the ordered dispatch_events timeline for a handoff_id.',
      inputSchema: DispatchTimelineInputShape,
    },
    dispatchTimelineHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'dispatch.audit',
    {
      description: 'Return a reliability audit report for one handoff.',
      inputSchema: DispatchAuditInputShape,
    },
    dispatchAuditHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'permission.list_pending',
    { description: 'List pending tool-permission requests awaiting operator approval. Optional filters: conversation_id, parent_handoff_id, status (comma-separated).', inputSchema: PermissionListPendingInputShape },
    permissionListPendingHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'permission.get',
    { description: 'Returns a single permission_request row including raw_input_json for operator review before deciding.', inputSchema: PermissionGetInputShape },
    permissionGetHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'permission.approve',
    { description: 'Approve or reject a pending permission_request. remember="this_dispatch" auto-approves subsequent calls of the same tool within this dispatch.', inputSchema: PermissionApproveInputShape },
    permissionApproveHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.status',
    {
      description: 'Returns lean status for a handoff: { status, error_summary, worker_id, latency_seconds }. ~30x cheaper than handoff.get for routine polling.',
      inputSchema: ChainStatusInputShape,
    },
    chainStatusHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
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
    'chain.cancel',
    {
      description: 'Request cancellation of an in-flight handoff by handoff_id.',
      inputSchema: ChainCancelInputShape,
    },
    chainCancelHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.history',
    {
      description: 'DEPRECATED. Returns only `chain-terminated` events. Use `chain.get_messages` for the full conversation log, or `chain.get_response` for just the agent\'s text. Kept for backward compatibility.',
      inputSchema: ChainHistoryInputShape,
    },
    chainHistoryHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.get_messages',
    {
      description: 'Returns all events for a given conversation_id. Optionally filter by types array.',
      inputSchema: ChainGetMessagesInputShape,
    },
    chainGetMessagesHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.list_agents',
    {
      description: 'Returns the valid agent names from the loaded agentchat registry.',
      inputSchema: ChainListAgentsInputShape,
    },
    chainListAgentsHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'chain.get_response',
    {
      description: 'Returns the agent responses for a given conversation_id. which="final" returns the most recent response. which="all" returns all responses chronologically.',
      inputSchema: ChainGetResponseInputShape,
    },
    chainGetResponseHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'worktree.list',
    { description: 'Returns all currently-tracked worktrees from the manager.', inputSchema: WorktreeListInputShape },
    worktreeListHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'worktree.inspect',
    { description: 'Returns the diff and branch log for a specific worktree.', inputSchema: WorktreeInspectInputShape },
    worktreeInspectHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'worktree.cleanup',
    { description: 'Tears down a worktree by handoff ID.', inputSchema: WorktreeCleanupInputShape },
    worktreeCleanupHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'fs.glob',
    {
      description:
        'Find files inside the dispatch\'s worktree by glob pattern (e.g. "**/*.ts"). Honors .gitignore by default. Sorted by mtime desc. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGlobInputShape,
    },
    fsGlobHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'fs.grep',
    {
      description:
        'Search file contents in the dispatch\'s worktree using ripgrep. Two output modes: "content" returns {path, line, text} rows (default; cap 50/ceiling 500); "files_with_matches" returns paths only (cap 1000/ceiling 5000). handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGrepInputShape,
    },
    fsGrepHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'daemon.reload_config',
    { description: DAEMON_RELOAD_CONFIG_DESCRIPTION, inputSchema: DaemonReloadConfigInputShape },
    daemonReloadConfigHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  // Shell tools are always registered on the MCP surface; the daemon-side gate
  // (shellSessionPool === undefined → 503 shell_disabled) is the source of truth
  // for whether they actually do anything.
  server.registerTool(
    'shell_run',
    { inputSchema: ShellRunInputShape },
    shellRunHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'shell_close',
    { inputSchema: ShellCloseInputShape },
    shellCloseHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'shell_list',
    { inputSchema: ShellListInputShape },
    shellListHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  return server;
}
