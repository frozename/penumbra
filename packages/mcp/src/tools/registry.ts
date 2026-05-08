import type { DaemonClient } from '../daemon-client.js';
import { ObserveInputShape, observeHandler } from './observe.js';
import { RecallInputShape, recallHandler } from './recall.js';
import { SearchInputShape, searchHandler } from './search.js';
import { TimelineInputShape, timelineHandler } from './timeline.js';
import { GetObservationsInputShape, getObservationsHandler } from './get-observations.js';
import { CorpusBuildInputShape, corpusBuildHandler } from './corpus-build.js';
import { CorpusQueryInputShape, corpusQueryHandler } from './corpus-query.js';
import { CorpusListInputShape, corpusListHandler } from './corpus-list.js';
import { WorkflowListInputShape, workflowListHandler } from './workflow-list.js';
import { WorkflowRunInputShape, workflowRunHandler } from './workflow-run.js';
import { WorkflowSuggestInputShape, workflowSuggestHandler } from './workflow-suggest.js';
import { WorkflowHistoryInputShape, workflowHistoryHandler } from './workflow-history.js';
import { RecallStatusInputShape, recallStatusHandler } from './recall-status.js';
import { SessionEndInputShape, sessionEndHandler } from './session-end.js';
import { CostRecentInputShape, costRecentHandler } from './cost-recent.js';
import { CostQuotaStatusInputShape, costQuotaStatusHandler } from './cost-quota-status.js';
import {
  SubscriptionPressureStatusInputShape,
  subscriptionPressureStatusHandler,
} from './subscription-pressure-status.js';
import { AgentRankInputShape, agentRankHandler } from './agent-rank.js';
import { AgentRecommendInputShape, agentRecommendHandler } from './agent-recommend.js';
import { PlanStartInputShape, planStartHandler } from './plan-start.js';
import { PlanListInputShape, planListHandler } from './plan-list.js';
import { PlanStatusInputShape, planStatusHandler } from './plan-status.js';
import { PlanCancelInputShape, planCancelHandler } from './plan-cancel.js';
import { ListHandoffsInputShape, listHandoffsHandler } from './handoff-list.js';
import { ApproveHandoffInputShape, approveHandoffHandler } from './handoff-approve.js';
import { HandoffGetInputShape, handoffGetHandler } from './handoff-get.js';
import { DispatchAuditInputShape, dispatchAuditHandler } from './dispatch-audit.js';
import { DispatchTimelineInputShape, dispatchTimelineHandler } from './dispatch-timeline.js';
import { ChainStatusInputShape, chainStatusHandler } from './chain-status.js';
import { ChainStartInputShape, chainStartHandler } from './chain-start.js';
import { ChainHistoryInputShape, chainHistoryHandler } from './chain-history.js';
import { ChainGetMessagesInputShape, chainGetMessagesHandler } from './chain-get-messages.js';
import { ChainGetResponseInputShape, chainGetResponseHandler } from './chain-get-response.js';
import { ChainListAgentsInputShape, chainListAgentsHandler } from './chain-list-agents.js';
import { ChainCancelInputShape, chainCancelHandler } from './chain-cancel.js';
import { ChainSendMessageInputShape, chainSendMessageHandler } from './chain-send-message.js';
import { ChainWaitInputShape, chainWaitHandler } from './chain-wait.js';
import { WorktreeListInputShape, worktreeListHandler } from './worktree-list.js';
import { WorktreeInspectInputShape, worktreeInspectHandler } from './worktree-inspect.js';
import { WorktreeCleanupInputShape, worktreeCleanupHandler } from './worktree-cleanup.js';
import { FsGlobInputShape, fsGlobHandler } from './fs-glob.js';
import { FsGrepInputShape, fsGrepHandler } from './fs-grep.js';
import { PermissionListPendingInputShape, permissionListPendingHandler } from './permission-list-pending.js';
import { PermissionGetInputShape, permissionGetHandler } from './permission-get.js';
import { PermissionApproveInputShape, permissionApproveHandler } from './permission-approve.js';
import {
  DAEMON_RELOAD_CONFIG_DESCRIPTION,
  DaemonReloadConfigInputShape,
  daemonReloadConfigHandler,
} from './daemon-reload-config.js';
import { ShellRunInputShape, shellRunHandler } from './shell-run.js';
import { ShellCloseInputShape, shellCloseHandler } from './shell-close.js';
import { ShellListInputShape, shellListHandler } from './shell-list.js';
import { TaskFileInputShape, taskFileHandler } from './task-file.js';
import { TaskListInputShape, taskListHandler } from './task-list.js';
import { TaskGetInputShape, taskGetHandler } from './task-get.js';
import { MaestroSessionGetInputShape, maestroSessionGetHandler } from './maestro-session-get.js';
import { TaskNextInputShape, taskNextHandler } from './task-next.js';
import { TaskHeartbeatInputShape, taskHeartbeatHandler } from './task-heartbeat.js';
import { TaskCompleteInputShape, taskCompleteHandler } from './task-complete.js';
import { TaskFailInputShape, taskFailHandler } from './task-fail.js';
import { TaskCancelInputShape, taskCancelHandler } from './task-cancel.js';

export type ToolDescriptor = {
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type ToolDef = {
  descriptor: ToolDescriptor;
  makeHandler: (daemon: DaemonClient) => (args: unknown) => Promise<unknown>;
  readOnly: boolean;
};

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  'memory.observe': {
    descriptor: {
      description: 'Record an observation into Penumbra T0.',
      inputSchema: ObserveInputShape,
    },
    makeHandler: observeHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'memory.recall': {
    descriptor: {
      description: 'Retrieve top-K memories (T1+T2) by semantic similarity.',
      inputSchema: RecallInputShape,
    },
    makeHandler: recallHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.search': {
    descriptor: {
      description:
        'Step 1 of 3-layer recall: compact index of memory hits (id + title + snippet + score) over t1_fts/t2_fts with metadata filters. Cheap to scan; pair with memory.timeline + memory.get_observations.',
      inputSchema: SearchInputShape,
    },
    makeHandler: searchHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.timeline': {
    descriptor: {
      description:
        'Step 2 of 3-layer recall: chronological neighbors around an anchor t2 memory. Use to see what was happening just before/after a hit.',
      inputSchema: TimelineInputShape,
    },
    makeHandler: timelineHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.get_observations': {
    descriptor: {
      description:
        'Step 3 of 3-layer recall: hydrate full bodies for IDs returned by memory.search or memory.timeline. Always batch — do not call once per ID.',
      inputSchema: GetObservationsInputShape,
    },
    makeHandler: getObservationsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.corpus_build': {
    descriptor: {
      description:
        'Build (or rebuild by name) a knowledge corpus: a named, persisted bundle of t2 observations matching a metadata filter (project_id / obs_type / concept / file_path / date range). Use as a topical RAG slice that survives across recalls.',
      inputSchema: CorpusBuildInputShape,
    },
    makeHandler: corpusBuildHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'memory.corpus_query': {
    descriptor: {
      description:
        'Vector-rerank a query against members of a named corpus only. Returns the same hit shape as memory.search but constrained to the corpus.',
      inputSchema: CorpusQueryInputShape,
    },
    makeHandler: corpusQueryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.corpus_list': {
    descriptor: {
      description: 'List all knowledge corpora with their member counts and creation timestamps.',
      inputSchema: CorpusListInputShape,
    },
    makeHandler: corpusListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'workflow.list': {
    descriptor: {
      description: 'List registered workflows with their triggers and descriptions.',
      inputSchema: WorkflowListInputShape,
    },
    makeHandler: workflowListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'workflow.run': {
    descriptor: {
      description: 'Run a registered workflow by name.',
      inputSchema: WorkflowRunInputShape,
    },
    makeHandler: workflowRunHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'workflow.suggest': {
    descriptor: {
      description: 'Suggest workflows matching current state thresholds.',
      inputSchema: WorkflowSuggestInputShape,
    },
    makeHandler: workflowSuggestHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'workflow.history': {
    descriptor: {
      description: 'Past run stats + recent outcomes for a named workflow.',
      inputSchema: WorkflowHistoryInputShape,
    },
    makeHandler: workflowHistoryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'memory.status': {
    descriptor: {
      description:
        'Recall corpus health snapshot: tier counts (t0/t1/t2), t2 obs_type/severity histograms, t1 promotion backlog (unpromoted + failed), corpora count, and last recall_audit timestamp.',
      inputSchema: RecallStatusInputShape,
    },
    makeHandler: recallStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'cost.recent': {
    descriptor: {
      description: 'Returns the recent cost ledger summary (totals + by_provider) over a 24h-default window.',
      inputSchema: CostRecentInputShape,
    },
    makeHandler: costRecentHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'cost.quota_status': {
    descriptor: {
      description: 'Returns per-provider quota status: used vs configured 24h-rolling cost/token budgets.',
      inputSchema: CostQuotaStatusInputShape,
    },
    makeHandler: costQuotaStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'subscription_pressure_status': {
    descriptor: {
      description:
        'Per-(provider, window_label) subscription rate-limit snapshots aggregated from t0_events. Replaces fictional USD readouts for subscription agents.',
      inputSchema: SubscriptionPressureStatusInputShape,
    },
    makeHandler: subscriptionPressureStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'agent.rank': {
    descriptor: {
      description: 'Rank agents for a task type using captured dispatch outcome, cost, and latency data.',
      inputSchema: AgentRankInputShape,
    },
    makeHandler: agentRankHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'agent.recommend': {
    descriptor: {
      description:
        'Recommend agents for a task type ranked by recent performance. Inputs: task_type (required), risk_class (optional), window_days (optional, default 7).',
      inputSchema: AgentRecommendInputShape,
    },
    makeHandler: agentRecommendHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'plan.start': {
    descriptor: {
      description: 'Register a plan file with the daemon and return its plan_id and status.',
      inputSchema: PlanStartInputShape,
    },
    makeHandler: planStartHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'plan.list': {
    descriptor: {
      description: 'List registered plans, optionally filtered by status.',
      inputSchema: PlanListInputShape,
    },
    makeHandler: planListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'plan.status': {
    descriptor: {
      description: 'Return a plan and its hydrated task records by plan_id.',
      inputSchema: PlanStatusInputShape,
    },
    makeHandler: planStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'plan.cancel': {
    descriptor: {
      description: 'Cancel a registered plan by plan_id.',
      inputSchema: PlanCancelInputShape,
    },
    makeHandler: planCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'session.end': {
    descriptor: {
      description:
        'Trigger a synchronous T1 rollup for the named session. Returns the rollup_id, or null if there was nothing to roll up (already rolled up or no events).',
      inputSchema: SessionEndInputShape,
    },
    makeHandler: sessionEndHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'handoff.list_pending': {
    descriptor: {
      description: 'List pending agent handoffs awaiting approval.',
      inputSchema: ListHandoffsInputShape,
    },
    makeHandler: listHandoffsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'handoff.approve': {
    descriptor: {
      description: 'Approve, redirect, or reject a pending handoff.',
      inputSchema: ApproveHandoffInputShape,
    },
    makeHandler: approveHandoffHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'handoff.get': {
    descriptor: {
      description: 'Returns the current state of a single handoff.',
      inputSchema: HandoffGetInputShape,
    },
    makeHandler: handoffGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'dispatch.timeline': {
    descriptor: {
      description: 'Returns the ordered dispatch_events timeline for a handoff_id.',
      inputSchema: DispatchTimelineInputShape,
    },
    makeHandler: dispatchTimelineHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'dispatch.audit': {
    descriptor: {
      description: 'Return a reliability audit report for one handoff.',
      inputSchema: DispatchAuditInputShape,
    },
    makeHandler: dispatchAuditHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'permission.list_pending': {
    descriptor: {
      description:
        'List pending tool-permission requests awaiting operator approval. Optional filters: conversation_id, parent_handoff_id, status (comma-separated).',
      inputSchema: PermissionListPendingInputShape,
    },
    makeHandler: permissionListPendingHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'permission.get': {
    descriptor: {
      description: 'Returns a single permission_request row including raw_input_json for operator review before deciding.',
      inputSchema: PermissionGetInputShape,
    },
    makeHandler: permissionGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'permission.approve': {
    descriptor: {
      description:
        'Approve or reject a pending permission_request. remember="this_dispatch" auto-approves subsequent calls of the same tool within this dispatch.',
      inputSchema: PermissionApproveInputShape,
    },
    makeHandler: permissionApproveHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'chain.status': {
    descriptor: {
      description:
        'Returns lean status for a handoff: { status, error_summary, worker_id, latency_seconds }. ~30x cheaper than handoff.get for routine polling.',
      inputSchema: ChainStatusInputShape,
    },
    makeHandler: chainStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'chain.start': {
    descriptor: {
      description:
        'Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches the chain headlessly. Poll handoff.list_pending to monitor.',
      inputSchema: ChainStartInputShape,
    },
    makeHandler: chainStartHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'chain.wait': {
    descriptor: {
      description: 'Block until the conversation reaches a terminal state (completed or failed) or timeout.',
      inputSchema: ChainWaitInputShape,
    },
    makeHandler: chainWaitHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'chain.cancel': {
    descriptor: {
      description: 'Request cancellation of an in-flight handoff by handoff_id.',
      inputSchema: ChainCancelInputShape,
    },
    makeHandler: chainCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'chain_send_message': {
    descriptor: {
      description:
        'Inject a user-text message into a live ACP child dispatch. Use to answer questions a child agent has emitted while waiting for input. Requires the dispatch to still be running and the agent to be on a mid-session-inject-capable adapter (stdio-acp, claude-acp*, codex-acp).',
      inputSchema: ChainSendMessageInputShape,
    },
    makeHandler: chainSendMessageHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'chain.history': {
    descriptor: {
      description:
        "DEPRECATED. Returns only `chain-terminated` events. Use `chain.get_messages` for the full conversation log, or `chain.get_response` for just the agent's text. Kept for backward compatibility.",
      inputSchema: ChainHistoryInputShape,
    },
    makeHandler: chainHistoryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'chain.get_messages': {
    descriptor: {
      description: 'Returns all events for a given conversation_id. Optionally filter by types array.',
      inputSchema: ChainGetMessagesInputShape,
    },
    makeHandler: chainGetMessagesHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'chain.list_agents': {
    descriptor: {
      description: 'Returns the valid agent names from the loaded agentchat registry.',
      inputSchema: ChainListAgentsInputShape,
    },
    makeHandler: chainListAgentsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'chain.get_response': {
    descriptor: {
      description:
        'Returns the agent responses for a given conversation_id. which="final" returns the most recent response. which="all" returns all responses chronologically.',
      inputSchema: ChainGetResponseInputShape,
    },
    makeHandler: chainGetResponseHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'worktree.list': {
    descriptor: {
      description: 'Returns all currently-tracked worktrees from the manager.',
      inputSchema: WorktreeListInputShape,
    },
    makeHandler: worktreeListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'worktree.inspect': {
    descriptor: {
      description: 'Returns the diff and branch log for a specific worktree.',
      inputSchema: WorktreeInspectInputShape,
    },
    makeHandler: worktreeInspectHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'worktree.cleanup': {
    descriptor: {
      description: 'Tears down a worktree by handoff ID.',
      inputSchema: WorktreeCleanupInputShape,
    },
    makeHandler: worktreeCleanupHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'fs.glob': {
    descriptor: {
      description:
        'Find files inside the dispatch\'s worktree by glob pattern (e.g. "**/*.ts"). Honors .gitignore by default. Sorted by mtime desc. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGlobInputShape,
    },
    makeHandler: fsGlobHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'fs.grep': {
    descriptor: {
      description:
        'Search file contents in the dispatch\'s worktree using ripgrep. Two output modes: "content" returns {path, line, text} rows (default; cap 50/ceiling 500); "files_with_matches" returns paths only (cap 1000/ceiling 5000). handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGrepInputShape,
    },
    makeHandler: fsGrepHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'daemon.reload_config': {
    descriptor: {
      description: DAEMON_RELOAD_CONFIG_DESCRIPTION,
      inputSchema: DaemonReloadConfigInputShape,
    },
    makeHandler: daemonReloadConfigHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'shell_run': {
    descriptor: {
      description: 'Run a shell command inside a dispatch shell session.',
      inputSchema: ShellRunInputShape,
    },
    makeHandler: shellRunHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'shell_close': {
    descriptor: {
      description: 'Close a dispatch shell session.',
      inputSchema: ShellCloseInputShape,
    },
    makeHandler: shellCloseHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'shell_list': {
    descriptor: {
      description: 'List active dispatch shell sessions.',
      inputSchema: ShellListInputShape,
    },
    makeHandler: shellListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'task.file': {
    descriptor: {
      description: 'Create a new task on the task board.',
      inputSchema: TaskFileInputShape,
    },
    makeHandler: taskFileHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'task.list': {
    descriptor: {
      description: 'List tasks with optional status/kind/eligibility/origin filters.',
      inputSchema: TaskListInputShape,
    },
    makeHandler: taskListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'task.get': {
    descriptor: {
      description: 'Get one task by id with optional lease/events/descendants expansions.',
      inputSchema: TaskGetInputShape,
    },
    makeHandler: taskGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'maestro.session_get': {
    descriptor: {
      description: 'Get one maestro session by task id, or null if no session row exists.',
      inputSchema: MaestroSessionGetInputShape,
    },
    makeHandler: maestroSessionGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'task.next': {
    descriptor: {
      description: 'Lease the highest-priority eligible task for the provided agent, or null when none are available.',
      inputSchema: TaskNextInputShape,
    },
    makeHandler: taskNextHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  'task.heartbeat': {
    descriptor: {
      description: 'Heartbeat an active task lease.',
      inputSchema: TaskHeartbeatInputShape,
    },
    makeHandler: taskHeartbeatHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'task.complete': {
    descriptor: {
      description: 'Complete a leased task and persist its result payload.',
      inputSchema: TaskCompleteInputShape,
    },
    makeHandler: taskCompleteHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'task.fail': {
    descriptor: {
      description: 'Fail a leased task with a reason.',
      inputSchema: TaskFailInputShape,
    },
    makeHandler: taskFailHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  'task.cancel': {
    descriptor: {
      description: 'Cancel a task by id.',
      inputSchema: TaskCancelInputShape,
    },
    makeHandler: taskCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
};
