import type { DaemonClient } from '../daemon-client.js';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ObserveInputShape, observeHandler } from './observe.js';
import {
  TaskDraftListPendingEscalationsInputShape,
  TaskDraftListPendingInputShape,
  taskDraftListPendingEscalationsHandler,
  taskDraftListPendingHandler,
} from './task-draft.js';
import { RecallInputShape, recallHandler } from './recall.js';
import { SearchInputShape, searchHandler } from './search.js';
import { VerifyInputShape, verifyHandler } from './verify.js';
import { MemoryVerifyAuthorizeInputShape, memoryVerifyAuthorizeHandler } from './memory-verify-authorize.js';
import { TimelineInputShape, timelineHandler } from './timeline.js';
import { GetObservationsInputShape, getObservationsHandler } from './get-observations.js';
import { CorpusBuildInputShape, corpusBuildHandler } from './corpus-build.js';
import { CorpusQueryInputShape, corpusQueryHandler } from './corpus-query.js';
import { CorpusListInputShape, corpusListHandler } from './corpus-list.js';
import { WorkflowListInputShape, workflowListHandler } from './workflow-list.js';
import {
  WorkflowRunInputShape,
  workflowRunHandler,
  type WorkflowRunHandlerOpts,
} from './workflow-run.js';
import {
  WorkflowStatusInputShape,
  WorkflowWaitInputShape,
  workflowStatusHandler,
  workflowWaitHandler,
} from './workflow-status.js';
import { WorkflowSuggestInputShape, workflowSuggestHandler } from './workflow-suggest.js';
import { WorkflowHistoryInputShape, workflowHistoryHandler } from './workflow-history.js';
import { BrainstormInputShape, brainstormHandler } from './brainstorm.js';
import { PlanOpenInputShape, planOpenHandler } from './plan-open.js';
import { LaneOpenInputShape, laneOpenHandler } from './lane-open.js';
import { LaneCloseInputShape, laneCloseHandler } from './lane-close.js';
import { LaneLedgerRecentInputShape, laneLedgerRecentHandler } from './lane-ledger-recent.js';
import { RecallStatusInputShape, recallStatusHandler } from './recall-status.js';
import { MemoryEfficacyRecentInputShape, memoryEfficacyRecentHandler } from './memory-efficacy-recent.js';
import { MemoryVerificationEventsInputShape, memoryVerificationEventsHandler } from './memory-verification-events.js';
import { QualityStatusInputShape, qualityStatusHandler } from './quality-status.js';
import { MemoryEfficacyRebuildInputShape, memoryEfficacyRebuildHandler } from './memory-efficacy-rebuild.js';
import { MemoryEfficacyJobStatusInputShape, memoryEfficacyJobStatusHandler } from './memory-efficacy-job-status.js';
import { MemoryEfficacyJobsInputShape, memoryEfficacyJobsHandler } from './memory-efficacy-jobs.js';
import { SessionEndInputShape, sessionEndHandler } from './session-end.js';
import { CostRecentInputShape, costRecentHandler } from './cost-recent.js';
import {
  COST_QUOTA_STATUS_DESCRIPTION,
  CostQuotaStatusInputShape,
  costQuotaStatusHandler,
} from './cost-quota-status.js';
import {
  SubscriptionPressureStatusInputShape,
  subscriptionPressureStatusHandler,
} from './subscription-pressure-status.js';
import { AgentRankInputShape, agentRankHandler } from './agent-rank.js';
import { AgentRecommendInputShape, agentRecommendHandler } from './agent-recommend.js';
import { AgentRouteForInputShape, agentRouteForHandler } from './agent-route-for.js';
import { PlanStartInputShape, planStartHandler } from './plan-start.js';
import { PlanListInputShape, planListHandler } from './plan-list.js';
import { PlanStatusInputShape, planStatusHandler } from './plan-status.js';
import { PlanCancelInputShape, planCancelHandler } from './plan-cancel.js';
import { ListHandoffsInputShape, listHandoffsHandler } from './handoff-list.js';
import { ApproveHandoffInputShape, approveHandoffHandler } from './handoff-approve.js';
import { HandoffGetInputShape, handoffGetHandler } from './handoff-get.js';
import { DispatchAuditInputShape, dispatchAuditHandler } from './dispatch-audit.js';
import { DispatchLandInputShape, dispatchLandHandler } from './dispatch-land.js';
import { DispatchTimelineInputShape, dispatchTimelineHandler } from './dispatch-timeline.js';
import { ChainStatusInputShape, chainStatusHandler } from './chain-status.js';
import {
  ChainStartInputShape,
  chainStartHandler,
  type ChainStartHandlerOpts,
  RegistryUnavailableError,
} from './chain-start.js';
import { ChainStartSimpleInputShape, chainStartSimpleHandler } from './chain-start-simple.js';
import { chainStartRefinedHandler } from './chain-start-refined.js';
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
import { MaestroSessionStartInputShape, maestroSessionStartHandler } from './maestro-session-start.js';
import { MaestroSessionStartAdhocInputShape, maestroSessionStartAdhocHandler } from './maestro-session-start-adhoc.js';
import { MaestroCapabilitiesInputShape, maestroCapabilitiesHandler } from './maestro-capabilities.js';
import { TaskNextInputShape, taskNextHandler } from './task-next.js';
import { TaskHeartbeatInputShape, taskHeartbeatHandler } from './task-heartbeat.js';
import { TaskCompleteInputShape, taskCompleteHandler } from './task-complete.js';
import { TaskFailInputShape, taskFailHandler } from './task-fail.js';
import { TaskCancelInputShape, taskCancelHandler } from './task-cancel.js';
import {
  defaultProjectRegistryPath,
  findProjectIdByCwd,
  loadProjectRegistry,
} from '@penumbra/core';
import {
  ReconcilerSweepOrphanPrsInputShape,
  reconcilerSweepOrphanPrsHandler,
} from './reconciler-sweep-orphan-prs.js';
import {
  ReconcilerVerdictsInputShape,
  reconcilerVerdictsHandler,
} from './reconciler-verdicts.js';
import { TaskLinkGhInputShape, taskLinkGhHandler } from './task-link-gh.js';
import { TaskCommentGhInputShape, taskCommentGhHandler } from './task-comment-gh.js';
import { TaskUnlinkGhInputShape, taskUnlinkGhHandler } from './task-unlink-gh.js';
import { TaskSyncGhNowInputShape, taskSyncGhNowHandler } from './task-sync-gh-now.js';
import { LongLivedListInputShape, longLivedListHandler } from './long-lived-list-mcp.js';
import { LongLivedGetInputShape, longLivedGetHandler } from './long-lived-get-mcp.js';
import { LongLivedPauseInputShape, longLivedPauseHandler } from './long-lived-pause-mcp.js';
import { LongLivedResumeInputShape, longLivedResumeHandler } from './long-lived-resume-mcp.js';
import { LongLivedRetireInputShape, longLivedRetireHandler } from './long-lived-retire-mcp.js';
import { LongLivedTickInputShape, longLivedTickHandler } from './long-lived-tick-mcp.js';
import { LongLivedStateGetInputShape, longLivedStateGetHandler } from './long-lived-state-get-mcp.js';
import { LongLivedStateSetInputShape, longLivedStateSetHandler } from './long-lived-state-set-mcp.js';
import { LongLivedPendingActionsInputShape, longLivedPendingActionsHandler } from './long-lived-pending-actions-mcp.js';
import {
  LongLivedSelfStateGetInputShape,
  longLivedSelfStateGetHandler,
} from './long-lived-self-state-get-mcp.js';
import {
  LongLivedSelfStateSetInputShape,
  longLivedSelfStateSetHandler,
} from './long-lived-self-state-set-mcp.js';
import {
  LongLivedSelfPendingActionsInputShape,
  longLivedSelfPendingActionsHandler,
} from './long-lived-self-pending-actions-mcp.js';
import { LongLivedApproveActionInputShape, longLivedApproveActionHandler } from './long-lived-approve-action-mcp.js';
import { LongLivedRejectActionInputShape, longLivedRejectActionHandler } from './long-lived-reject-action-mcp.js';
import { LongLivedInjectGoalInputShape, longLivedInjectGoalHandler } from './long-lived-inject-goal-mcp.js';
import { LongLivedAuditInputShape, longLivedAuditHandler } from './long-lived-audit-mcp.js';
import { LongLivedTicksInputShape, longLivedTicksHandler } from './long-lived-ticks-mcp.js';
import { withActingOnEnvelope } from './with-acting-on.js';
import {
  MemoryListPendingDreamActionsInputShape,
  memoryListPendingDreamActionsHandler,
} from './memory-list-pending-dream-actions.js';

export type ToolDescriptor = {
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type ToolDef = {
  descriptor: ToolDescriptor;
  makeHandler: (daemon: DaemonClient, opts?: unknown) => (args: unknown) => Promise<unknown>;
  readOnly: boolean;
  handlerOpts?: () => unknown;
};

type ProjectRegistryResolverDeps = {
  cwd: () => string;
  defaultRegistryPath: () => string;
  statPath: (path: string) => { mtimeMs: number };
  loadRegistry: (path: string) => ReturnType<typeof loadProjectRegistry>;
  findProjectId: (registry: ReturnType<typeof loadProjectRegistry>, cwd: string) => string | undefined;
};

type ProjectRegistryCache = {
  path: string;
  mtimeMs: number;
  registry: ReturnType<typeof loadProjectRegistry>;
};

type MissingProjectRegistryCache = {
  path: string;
  parentDir: string;
  parentMtimeMs: number;
};

let cachedProjectRegistry: ProjectRegistryCache | null = null;
let missingProjectRegistryCache: MissingProjectRegistryCache | null = null;

function isEnoentError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

function loadProjectRegistryFromCache(
  registryPath: string,
  deps: Pick<ProjectRegistryResolverDeps, 'statPath' | 'loadRegistry'>,
): ReturnType<typeof loadProjectRegistry> | undefined {
  if (missingProjectRegistryCache !== null && missingProjectRegistryCache.path === registryPath) {
    try {
      const parentMtimeMs = deps.statPath(missingProjectRegistryCache.parentDir).mtimeMs;
      if (parentMtimeMs === missingProjectRegistryCache.parentMtimeMs) return undefined;
    } catch {
      return undefined;
    }
    missingProjectRegistryCache = null;
  }

  let mtimeMs: number;
  try {
    mtimeMs = deps.statPath(registryPath).mtimeMs;
  } catch (err) {
    if (isEnoentError(err)) {
      const parentDir = dirname(registryPath);
      let parentMtimeMs = -1;
      try {
        parentMtimeMs = deps.statPath(parentDir).mtimeMs;
      } catch {
        // Keep sentinel -1 when parent dir stats are unavailable.
      }
      missingProjectRegistryCache = {
        path: registryPath,
        parentDir,
        parentMtimeMs,
      };
      cachedProjectRegistry = null;
      return undefined;
    }
    throw err;
  }

  missingProjectRegistryCache = null;
  if (
    cachedProjectRegistry !== null &&
    cachedProjectRegistry.path === registryPath &&
    cachedProjectRegistry.mtimeMs === mtimeMs
  ) {
    return cachedProjectRegistry.registry;
  }

  const registry = deps.loadRegistry(registryPath);
  cachedProjectRegistry = { path: registryPath, mtimeMs, registry };
  return registry;
}

const DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS: ProjectRegistryResolverDeps = {
  cwd: () => process.cwd(),
  defaultRegistryPath: defaultProjectRegistryPath,
  statPath: statSync,
  loadRegistry: loadProjectRegistry,
  findProjectId: findProjectIdByCwd,
};

export function __resetProjectRegistryCacheForTest(): void {
  cachedProjectRegistry = null;
  missingProjectRegistryCache = null;
}

export function createProjectIdResolverFromCwd(opts?: {
  cwd?: string;
  registryPath?: string;
  loadRegistry?: (path: string) => ReturnType<typeof loadProjectRegistry>;
  findProjectId?: (registry: ReturnType<typeof loadProjectRegistry>, cwd: string) => string | undefined;
  statPath?: (path: string) => { mtimeMs: number };
}): () => string | undefined {
  const deps: ProjectRegistryResolverDeps = {
    cwd: () => opts?.cwd ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.cwd(),
    defaultRegistryPath: DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.defaultRegistryPath,
    statPath: opts?.statPath ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.statPath,
    loadRegistry: opts?.loadRegistry ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.loadRegistry,
    findProjectId: opts?.findProjectId ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.findProjectId,
  };

  return () => {
    const registryPath = opts?.registryPath ?? process.env.PENUMBRA_PROJECTS_YAML ?? deps.defaultRegistryPath();
    try {
      const registry = loadProjectRegistryFromCache(registryPath, deps);
      if (registry === undefined) return undefined;
      return deps.findProjectId(registry, deps.cwd());
    } catch (err) {
      logWarn('chain_start.project_registry_unavailable', { registryPath, err });
      const message = err instanceof Error ? err.message : String(err);
      throw new RegistryUnavailableError(message);
    }
  };
}

export function createProjectIdResolverFromPath(opts?: {
  registryPath?: string;
  loadRegistry?: (path: string) => ReturnType<typeof loadProjectRegistry>;
  findProjectId?: (registry: ReturnType<typeof loadProjectRegistry>, cwd: string) => string | undefined;
  statPath?: (path: string) => { mtimeMs: number };
}): (callerCwd: string) => string | undefined {
  const deps: ProjectRegistryResolverDeps = {
    cwd: () => DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.cwd(),
    defaultRegistryPath: DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.defaultRegistryPath,
    statPath: opts?.statPath ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.statPath,
    loadRegistry: opts?.loadRegistry ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.loadRegistry,
    findProjectId: opts?.findProjectId ?? DEFAULT_PROJECT_REGISTRY_RESOLVER_DEPS.findProjectId,
  };

  return (callerCwd: string) => {
    const registryPath = opts?.registryPath ?? process.env.PENUMBRA_PROJECTS_YAML ?? deps.defaultRegistryPath();
    try {
      const registry = loadProjectRegistryFromCache(registryPath, deps);
      if (registry === undefined) return undefined;
      return deps.findProjectId(registry, callerCwd);
    } catch (err) {
      logWarn('chain_start.project_registry_unavailable_for_caller_cwd', { registryPath, err });
      const message = err instanceof Error ? err.message : String(err);
      throw new RegistryUnavailableError(message);
    }
  };
}

function logWarn(event: string, data: Record<string, unknown>): void {
  console.warn({ event, ...data });
}

const RAW_TOOL_REGISTRY: Record<string, ToolDef> = {
  memory_observe: {
    descriptor: {
      description: 'Record an observation into Penumbra T0.',
      inputSchema: ObserveInputShape,
    },
    makeHandler: observeHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_draft_list_pending: {
    descriptor: {
      description: 'List pending task draft lifecycle events by latest state, oldest-first for FIFO processing.',
      inputSchema: TaskDraftListPendingInputShape,
    },
    makeHandler: taskDraftListPendingHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  task_draft_list_pending_escalations: {
    descriptor: {
      description: 'List task_drafts whose latest lifecycle event is task_draft_escalation, joined back to the original draft payload. Used by the escalation refiner tier.',
      inputSchema: TaskDraftListPendingEscalationsInputShape,
    },
    makeHandler: taskDraftListPendingEscalationsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_recall: {
    descriptor: {
      description: 'Retrieve top-K memories (T1+T2) by semantic similarity.',
      inputSchema: RecallInputShape,
    },
    makeHandler: recallHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_search: {
    descriptor: {
      description:
        'Step 1 of 3-layer recall: compact index of memory hits (id + title + snippet + score) over t1_fts/t2_fts with metadata filters. Cheap to scan; pair with memory_timeline + memory_get_observations.',
      inputSchema: SearchInputShape,
    },
    makeHandler: searchHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_verify: {
    descriptor: {
      description: 'Mark a t2 memory as verified and update its freshness metadata.',
      inputSchema: VerifyInputShape,
    },
    makeHandler: verifyHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  memory_verify_authorize: {
    descriptor: {
      description: 'Authorize memory verification with basis validation and record the authorization provenance.',
      inputSchema: MemoryVerifyAuthorizeInputShape,
    },
    makeHandler: memoryVerifyAuthorizeHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  memory_timeline: {
    descriptor: {
      description:
        'Step 2 of 3-layer recall: chronological neighbors around an anchor t2 memory. Use to see what was happening just before/after a hit.',
      inputSchema: TimelineInputShape,
    },
    makeHandler: timelineHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_get_observations: {
    descriptor: {
      description:
        'Step 3 of 3-layer recall: hydrate full bodies for IDs returned by memory_search or memory_timeline. Always batch — do not call once per ID.',
      inputSchema: GetObservationsInputShape,
    },
    makeHandler: getObservationsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_corpus_build: {
    descriptor: {
      description:
        'Build (or rebuild by name) a knowledge corpus: a named, persisted bundle of t2 observations matching a metadata filter (project_id / obs_type / concept / file_path / date range). Use as a topical RAG slice that survives across recalls.',
      inputSchema: CorpusBuildInputShape,
    },
    makeHandler: corpusBuildHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  memory_corpus_query: {
    descriptor: {
      description:
        'Vector-rerank a query against members of a named corpus only. Returns the same hit shape as memory_search but constrained to the corpus.',
      inputSchema: CorpusQueryInputShape,
    },
    makeHandler: corpusQueryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_corpus_list: {
    descriptor: {
      description: 'List all knowledge corpora with their member counts and creation timestamps.',
      inputSchema: CorpusListInputShape,
    },
    makeHandler: corpusListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_efficacy_recent: {
    descriptor: {
      description:
        'Recent-window read of how often reviewer findings indicate a memory failure mode (missed_registration / recall_miss / memory_ignored / not_memory_related).',
      inputSchema: MemoryEfficacyRecentInputShape,
    },
    makeHandler: memoryEfficacyRecentHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_verification_events: {
    descriptor: {
      description:
        'Read the audit trail for a verified memory, including verifier identity, claimed-by provenance, reason, and timestamp.',
      inputSchema: MemoryVerificationEventsInputShape,
    },
    makeHandler: memoryVerificationEventsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  quality_status: {
    descriptor: {
      description:
        'Composite quality snapshot spanning lane health, adversarial review outcomes, agent recommendations, memory efficacy, and subscription pressure.',
      inputSchema: QualityStatusInputShape,
    },
    makeHandler: qualityStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_efficacy_rebuild: {
    descriptor: {
      description:
        'Enqueue an async rebuild of the memory_efficacy_cache by scanning review syntheses and classifying findings via Sirius LLM. Returns {job_id, status} for tracking with memory_efficacy_job_status.',
      inputSchema: MemoryEfficacyRebuildInputShape,
    },
    makeHandler: memoryEfficacyRebuildHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  memory_efficacy_job_status: {
    descriptor: {
      description:
        'Check the status of an async memory_efficacy_rebuild job.',
      inputSchema: MemoryEfficacyJobStatusInputShape,
    },
    makeHandler: memoryEfficacyJobStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_efficacy_jobs: {
    descriptor: {
      description:
        'List recent memory_efficacy_rebuild jobs with optional status filter.',
      inputSchema: MemoryEfficacyJobsInputShape,
    },
    makeHandler: memoryEfficacyJobsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  workflow_list: {
    descriptor: {
      description: 'List registered workflows with their triggers and descriptions.',
      inputSchema: WorkflowListInputShape,
    },
    makeHandler: workflowListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  workflow_run: {
    descriptor: {
      description: 'Run a registered workflow by name.',
      inputSchema: WorkflowRunInputShape,
    },
    makeHandler: workflowRunHandler as unknown as ToolDef['makeHandler'],
    handlerOpts: () => ({ resolveCwd: () => process.cwd() }) satisfies WorkflowRunHandlerOpts,
    readOnly: false,
  },
  workflow_status: {
    descriptor: {
      description: 'Check the status of an async workflow run.',
      inputSchema: WorkflowStatusInputShape,
    },
    makeHandler: workflowStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  workflow_wait: {
    descriptor: {
      description: 'Block until an async workflow run reaches a terminal state or times out.',
      inputSchema: WorkflowWaitInputShape,
    },
    makeHandler: workflowWaitHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  workflow_suggest: {
    descriptor: {
      description: 'Suggest workflows matching current state thresholds.',
      inputSchema: WorkflowSuggestInputShape,
    },
    makeHandler: workflowSuggestHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  workflow_history: {
    descriptor: {
      description: 'Past run stats + recent outcomes for a named workflow.',
      inputSchema: WorkflowHistoryInputShape,
    },
    makeHandler: workflowHistoryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  brainstorm: {
    descriptor: {
      description: 'Run the brainstorm workflow with topic and optional constraints.',
      inputSchema: BrainstormInputShape,
    },
    makeHandler: brainstormHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  plan_open: {
    descriptor: {
      description: 'Open a plan from a goal and optional steps by generating a minimal plan file and registering it.',
      inputSchema: PlanOpenInputShape,
    },
    makeHandler: planOpenHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  lane_open: {
    descriptor: {
      description: 'Open a lane for an implementer handoff and task class.',
      inputSchema: LaneOpenInputShape,
    },
    makeHandler: laneOpenHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  lane_close: {
    descriptor: {
      description: 'Close a lane with a reviewer outcome.',
      inputSchema: LaneCloseInputShape,
    },
    makeHandler: laneCloseHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  lane_ledger_recent: {
    descriptor: {
      description: 'Fetch recent lanes with optional filters.',
      inputSchema: LaneLedgerRecentInputShape,
    },
    makeHandler: laneLedgerRecentHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  memory_status: {
    descriptor: {
      description:
        'Recall corpus health snapshot: tier counts (t0/t1/t2), t2 obs_type/severity histograms, t1 promotion backlog (unpromoted + failed), corpora count, and last recall_audit timestamp.',
      inputSchema: RecallStatusInputShape,
    },
    makeHandler: recallStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_list: {
    descriptor: {
      description: 'List non-retired long-lived operators.',
      inputSchema: LongLivedListInputShape,
    },
    makeHandler: longLivedListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_get: {
    descriptor: {
      description: 'Get full long-lived operator details.',
      inputSchema: LongLivedGetInputShape,
    },
    makeHandler: longLivedGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_pause: {
    descriptor: {
      description: 'Pause a long-lived operator.',
      inputSchema: LongLivedPauseInputShape,
    },
    makeHandler: longLivedPauseHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_resume: {
    descriptor: {
      description: 'Resume a paused long-lived operator.',
      inputSchema: LongLivedResumeInputShape,
    },
    makeHandler: longLivedResumeHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_retire: {
    descriptor: {
      description: 'Retire a long-lived operator.',
      inputSchema: LongLivedRetireInputShape,
    },
    makeHandler: longLivedRetireHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_tick: {
    descriptor: {
      description: 'Manually trigger a long-lived operator tick.',
      inputSchema: LongLivedTickInputShape,
    },
    makeHandler: longLivedTickHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_state_get: {
    descriptor: {
      description: 'Get a long-lived operator working memory snapshot.',
      inputSchema: LongLivedStateGetInputShape,
    },
    makeHandler: longLivedStateGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_state_set: {
    descriptor: {
      description: 'Update a long-lived operator working memory snapshot.',
      inputSchema: LongLivedStateSetInputShape,
    },
    makeHandler: longLivedStateSetHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_pending_actions: {
    descriptor: {
      description: 'List pending actions for a long-lived operator.',
      inputSchema: LongLivedPendingActionsInputShape,
    },
    makeHandler: longLivedPendingActionsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_self_state_get: {
    descriptor: {
      description: 'Get this long-lived agent working memory snapshot.',
      inputSchema: LongLivedSelfStateGetInputShape,
    },
    makeHandler: longLivedSelfStateGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_self_state_set: {
    descriptor: {
      description: 'Update this long-lived agent working memory snapshot.',
      inputSchema: LongLivedSelfStateSetInputShape,
    },
    makeHandler: longLivedSelfStateSetHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_self_pending_actions: {
    descriptor: {
      description: 'List pending actions for this long-lived agent.',
      inputSchema: LongLivedSelfPendingActionsInputShape,
    },
    makeHandler: longLivedSelfPendingActionsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_approve_action: {
    descriptor: {
      description: 'Approve a pending long-lived action.',
      inputSchema: LongLivedApproveActionInputShape,
    },
    makeHandler: longLivedApproveActionHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_reject_action: {
    descriptor: {
      description: 'Reject a pending long-lived action.',
      inputSchema: LongLivedRejectActionInputShape,
    },
    makeHandler: longLivedRejectActionHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_inject_goal: {
    descriptor: {
      description: 'Inject a goal into a long-lived operator.',
      inputSchema: LongLivedInjectGoalInputShape,
    },
    makeHandler: longLivedInjectGoalHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  long_lived_audit: {
    descriptor: {
      description: 'Read long-lived action audit rows.',
      inputSchema: LongLivedAuditInputShape,
    },
    makeHandler: longLivedAuditHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  long_lived_ticks: {
    descriptor: {
      description: 'Read long-lived tick rows.',
      inputSchema: LongLivedTicksInputShape,
    },
    makeHandler: longLivedTicksHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  cost_recent: {
    descriptor: {
      description: 'Returns the recent cost ledger summary (totals + by_provider) over a 24h-default window.',
      inputSchema: CostRecentInputShape,
    },
    makeHandler: costRecentHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  cost_quota_status: {
    descriptor: {
      description: COST_QUOTA_STATUS_DESCRIPTION,
      inputSchema: CostQuotaStatusInputShape,
    },
    makeHandler: costQuotaStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  subscription_pressure_status: {
    descriptor: {
      description:
        'Per-(provider, window_label) subscription rate-limit snapshots aggregated from t0_events. Replaces fictional USD readouts for subscription agents.',
      inputSchema: SubscriptionPressureStatusInputShape,
    },
    makeHandler: subscriptionPressureStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  agent_rank: {
    descriptor: {
      description: 'Rank agents for a task type using captured dispatch outcome, cost, and latency data.',
      inputSchema: AgentRankInputShape,
    },
    makeHandler: agentRankHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  agent_recommend: {
    descriptor: {
      description:
        'Recommend agents for a task type ranked by recent performance. Inputs: task_type (required), risk_class (optional), window_days (optional, default 7).',
      inputSchema: AgentRecommendInputShape,
    },
    makeHandler: agentRecommendHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  agent_route_for: {
    descriptor: {
      description: 'Route a task role to the best eligible agent using role allowlists, pressure state, and recent performance.',
      inputSchema: AgentRouteForInputShape,
    },
    makeHandler: agentRouteForHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  plan_start: {
    descriptor: {
      description: 'Register a plan file with the daemon and return its plan_id and status.',
      inputSchema: PlanStartInputShape,
    },
    makeHandler: planStartHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  plan_list: {
    descriptor: {
      description: 'List registered plans, optionally filtered by status.',
      inputSchema: PlanListInputShape,
    },
    makeHandler: planListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  plan_status: {
    descriptor: {
      description: 'Return a plan and its hydrated task records by plan_id.',
      inputSchema: PlanStatusInputShape,
    },
    makeHandler: planStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  plan_cancel: {
    descriptor: {
      description: 'Cancel a registered plan by plan_id.',
      inputSchema: PlanCancelInputShape,
    },
    makeHandler: planCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  session_end: {
    descriptor: {
      description:
        'Trigger a synchronous T1 rollup for the named session. Returns the rollup_id, or null if there was nothing to roll up (already rolled up or no events).',
      inputSchema: SessionEndInputShape,
    },
    makeHandler: sessionEndHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  handoff_list_pending: {
    descriptor: {
      description: 'List pending agent handoffs awaiting approval.',
      inputSchema: ListHandoffsInputShape,
    },
    makeHandler: listHandoffsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  handoff_approve: {
    descriptor: {
      description: 'Approve, redirect, or reject a pending handoff.',
      inputSchema: ApproveHandoffInputShape,
    },
    makeHandler: approveHandoffHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  handoff_get: {
    descriptor: {
      description: 'Returns the current state of a single handoff.',
      inputSchema: HandoffGetInputShape,
    },
    makeHandler: handoffGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  dispatch_timeline: {
    descriptor: {
      description: 'Returns the ordered dispatch_events timeline for a handoff_id.',
      inputSchema: DispatchTimelineInputShape,
    },
    makeHandler: dispatchTimelineHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  dispatch_audit: {
    descriptor: {
      description: 'Return a reliability audit report for one handoff.',
      inputSchema: DispatchAuditInputShape,
    },
    makeHandler: dispatchAuditHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  dispatch_land: {
    descriptor: {
      description:
        'Land an agent/<handoff_id> branch via curated squash or ff-only flow. Supports verdict gate + force override.',
      inputSchema: DispatchLandInputShape,
    },
    makeHandler: dispatchLandHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  permission_list_pending: {
    descriptor: {
      description:
        'List pending tool-permission requests awaiting operator approval. Optional filters: conversation_id, parent_handoff_id, status (comma-separated).',
      inputSchema: PermissionListPendingInputShape,
    },
    makeHandler: permissionListPendingHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  permission_get: {
    descriptor: {
      description: 'Returns a single permission_request row including raw_input_json for operator review before deciding.',
      inputSchema: PermissionGetInputShape,
    },
    makeHandler: permissionGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  permission_approve: {
    descriptor: {
      description:
        'Approve or reject a pending permission_request. remember="this_dispatch" auto-approves subsequent calls of the same tool within this dispatch.',
      inputSchema: PermissionApproveInputShape,
    },
    makeHandler: permissionApproveHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  chain_status: {
    descriptor: {
      description:
        'Returns lean status for a handoff: { status, error_summary, worker_id, latency_seconds }. ~30x cheaper than handoff_get for routine polling.',
      inputSchema: ChainStatusInputShape,
    },
    makeHandler: chainStatusHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  chain_start: {
    descriptor: {
      description:
        'Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches the chain headlessly. Poll handoff_list_pending to monitor.',
      inputSchema: ChainStartInputShape,
    },
    makeHandler: chainStartHandler as unknown as ToolDef['makeHandler'],
    handlerOpts: () =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_start_simple: {
    descriptor: {
      description:
        'Minimal-schema wrapper for chain_start. Takes {initial_agent, message[, project_id]}; hardcodes task_class=STANDARD, task_type=debug_diagnose, use_worktree=false, max_hops=2, trust_mode=config. Set PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1 requires project_id. See docs/notes/chain-start-caller-audit-2026-05-16.md.',
      inputSchema: ChainStartSimpleInputShape,
    },
    makeHandler: chainStartSimpleHandler as unknown as ToolDef['makeHandler'],
    handlerOpts: () =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_start_refined: {
    descriptor: {
      description:
        'Same schema as chain_start, but reshapes `message` through a fast LLM refiner before dispatch. Use when a dispatch is at risk of being misread by the target agent as session-bootstrap context, brainstorming material, or an approval ask. The refiner rewrites the message into imperative-first shape (no top-level markdown headers, leading verb, explicit "Design approved — execute end-to-end" framing when applicable). Input is zod-validated against the full chain_start schema BEFORE the refiner is called, so malformed inputs fail fast without LLM cost. Adds ~5-15s for the refiner call. Requires PENUMBRA_SIRIUS_BASE_URL on the daemon; route returns 503 if unconfigured.',
      inputSchema: ChainStartInputShape,
    },
    makeHandler: chainStartRefinedHandler as unknown as ToolDef['makeHandler'],
    handlerOpts: () =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_wait: {
    descriptor: {
      description: 'Block until the conversation reaches a terminal state (completed or failed) or timeout.',
      inputSchema: ChainWaitInputShape,
    },
    makeHandler: chainWaitHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  chain_cancel: {
    descriptor: {
      description: 'Request cancellation of an in-flight handoff by handoff_id.',
      inputSchema: ChainCancelInputShape,
    },
    makeHandler: chainCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  chain_send_message: {
    descriptor: {
      description:
        'Inject a user-text message into a live ACP child dispatch. Use to answer questions a child agent has emitted while waiting for input. Requires the dispatch to still be running and the agent to be on a mid-session-inject-capable adapter (stdio-acp, claude-acp*, codex-acp).',
      inputSchema: ChainSendMessageInputShape,
    },
    makeHandler: chainSendMessageHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  chain_history: {
    descriptor: {
      description:
        "DEPRECATED. Returns only `chain-terminated` events. Use `chain_get_messages` for the full conversation log, or `chain_get_response` for just the agent's text. Kept for backward compatibility.",
      inputSchema: ChainHistoryInputShape,
    },
    makeHandler: chainHistoryHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  chain_get_messages: {
    descriptor: {
      description: 'Returns all events for a given conversation_id. Optionally filter by types array.',
      inputSchema: ChainGetMessagesInputShape,
    },
    makeHandler: chainGetMessagesHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  chain_list_agents: {
    descriptor: {
      description: 'Returns the valid agent names from the loaded agentchat registry.',
      inputSchema: ChainListAgentsInputShape,
    },
    makeHandler: chainListAgentsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  chain_get_response: {
    descriptor: {
      description:
        'Returns the agent responses for a given conversation_id. which="final" returns the most recent response. which="all" returns all responses chronologically.',
      inputSchema: ChainGetResponseInputShape,
    },
    makeHandler: chainGetResponseHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  worktree_list: {
    descriptor: {
      description: 'Returns all currently-tracked worktrees from the manager.',
      inputSchema: WorktreeListInputShape,
    },
    makeHandler: worktreeListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  worktree_inspect: {
    descriptor: {
      description: 'Returns the diff and branch log for a specific worktree.',
      inputSchema: WorktreeInspectInputShape,
    },
    makeHandler: worktreeInspectHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  worktree_cleanup: {
    descriptor: {
      description: 'Tears down a worktree by handoff ID.',
      inputSchema: WorktreeCleanupInputShape,
    },
    makeHandler: worktreeCleanupHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  fs_glob: {
    descriptor: {
      description:
        'Find files inside the dispatch\'s worktree by glob pattern (e.g. "**/*.ts"). Honors .gitignore by default. Sorted by mtime desc. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGlobInputShape,
    },
    makeHandler: fsGlobHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  fs_grep: {
    descriptor: {
      description:
        'Search file contents in the dispatch\'s worktree using ripgrep. Two output modes: "content" returns {path, line, text} rows (default; cap 50/ceiling 500); "files_with_matches" returns paths only (cap 1000/ceiling 5000). handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGrepInputShape,
    },
    makeHandler: fsGrepHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  daemon_reload_config: {
    descriptor: {
      description: DAEMON_RELOAD_CONFIG_DESCRIPTION,
      inputSchema: DaemonReloadConfigInputShape,
    },
    makeHandler: daemonReloadConfigHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  reconciler_sweep_orphan_prs: {
    descriptor: {
      description:
        'Manually run the reconciler PR orphan sweeper. Scans open agent/<uuid> PRs, classifies superseded/stale, and closes according to dry_run/max_close.',
      inputSchema: ReconcilerSweepOrphanPrsInputShape,
    },
    makeHandler: reconcilerSweepOrphanPrsHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  reconciler_verdicts: {
    descriptor: {
      description:
        'List recent reconciler verdict events joined with handoff metadata. Useful for review/landing queues.',
      inputSchema: ReconcilerVerdictsInputShape,
    },
    makeHandler: reconcilerVerdictsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  shell_run: {
    descriptor: {
      description: 'Run a shell command inside a dispatch shell session.',
      inputSchema: ShellRunInputShape,
    },
    makeHandler: shellRunHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  shell_close: {
    descriptor: {
      description: 'Close a dispatch shell session.',
      inputSchema: ShellCloseInputShape,
    },
    makeHandler: shellCloseHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  shell_list: {
    descriptor: {
      description: 'List active dispatch shell sessions.',
      inputSchema: ShellListInputShape,
    },
    makeHandler: shellListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  task_file: {
    descriptor: {
      description: 'Create a new task on the task board. When gh_create is provided, GitHub issue creation is queued asynchronously (check task_get gh_create_status/gh_create_error).',
      inputSchema: TaskFileInputShape,
    },
    makeHandler: taskFileHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_list: {
    descriptor: {
      description: 'List tasks with optional status/kind/eligibility/origin filters.',
      inputSchema: TaskListInputShape,
    },
    makeHandler: taskListHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  task_get: {
    descriptor: {
      description: 'Get one task by id with optional lease/events/descendants expansions.',
      inputSchema: TaskGetInputShape,
    },
    makeHandler: taskGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  maestro_session_get: {
    descriptor: {
      description: 'Get one maestro session by task id, or null if no session row exists.',
      inputSchema: MaestroSessionGetInputShape,
    },
    makeHandler: maestroSessionGetHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  maestro_session_start: {
    descriptor: {
      description: 'Create a maestro session row for an orchestrate task with explicit maestro agent and budgets.',
      inputSchema: MaestroSessionStartInputShape,
    },
    makeHandler: maestroSessionStartHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  maestro_session_start_adhoc: {
    descriptor: {
      description: 'Create an orchestrate task and synchronously dispatch a pre-bound maestro session in one call.',
      inputSchema: MaestroSessionStartAdhocInputShape,
    },
    makeHandler: maestroSessionStartAdhocHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  maestro_capabilities: {
    descriptor: {
      description: 'Return canonical maestro capabilities: dispatchable agents, task types, and workflow names.',
      inputSchema: MaestroCapabilitiesInputShape,
    },
    makeHandler: maestroCapabilitiesHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  task_next: {
    descriptor: {
      description: 'Lease the highest-priority eligible task for the provided agent, or null when none are available.',
      inputSchema: TaskNextInputShape,
    },
    makeHandler: taskNextHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
  task_heartbeat: {
    descriptor: {
      description: 'Heartbeat an active task lease.',
      inputSchema: TaskHeartbeatInputShape,
    },
    makeHandler: taskHeartbeatHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_complete: {
    descriptor: {
      description: 'Complete a leased task and persist its result payload.',
      inputSchema: TaskCompleteInputShape,
    },
    makeHandler: taskCompleteHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_fail: {
    descriptor: {
      description: 'Fail a leased task with a reason.',
      inputSchema: TaskFailInputShape,
    },
    makeHandler: taskFailHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_cancel: {
    descriptor: {
      description: 'Cancel a task by id.',
      inputSchema: TaskCancelInputShape,
    },
    makeHandler: taskCancelHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_link_gh: {
    descriptor: {
      description: 'Link a task to a GitHub issue and enqueue async sync.',
      inputSchema: TaskLinkGhInputShape,
    },
    makeHandler: taskLinkGhHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_comment_gh: {
    descriptor: {
      description: 'Post a manual mirrored comment to the linked GitHub issue for this task.',
      inputSchema: TaskCommentGhInputShape,
    },
    makeHandler: taskCommentGhHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_unlink_gh: {
    descriptor: {
      description: 'Unlink a task from GitHub issue metadata without changing issue state.',
      inputSchema: TaskUnlinkGhInputShape,
    },
    makeHandler: taskUnlinkGhHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  task_sync_gh_now: {
    descriptor: {
      description: 'Sync one linked task (or all linked tasks) against GitHub issue state now.',
      inputSchema: TaskSyncGhNowInputShape,
    },
    makeHandler: taskSyncGhNowHandler as unknown as ToolDef['makeHandler'],
    readOnly: false,
  },
  memory_list_pending_dream_actions: {
    descriptor: {
      description:
        'List dream_actions awaiting human review (status queued or approved). Returns actions with untrusted_source flag and oldest_pending_age_hours computed from cycle started_at.',
      inputSchema: MemoryListPendingDreamActionsInputShape,
    },
    makeHandler: memoryListPendingDreamActionsHandler as unknown as ToolDef['makeHandler'],
    readOnly: true,
  },
};

export const TOOL_REGISTRY: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(RAW_TOOL_REGISTRY).map(([name, def]) => [
    name,
    {
      ...def,
      makeHandler: (daemon: DaemonClient) =>
        withActingOnEnvelope(
          def.makeHandler(daemon, def.handlerOpts?.()),
        ),
    } satisfies ToolDef,
  ]),
);
