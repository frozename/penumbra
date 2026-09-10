import { toTextContent } from "@novaproto/mcp-shared";
import {
  defaultProjectRegistryPath,
  findProjectIdByCwd,
  loadProjectRegistry,
} from "@penumbra/core";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";
import type { HandleStore } from "../handle-store.js";

import { agentRankHandler, AgentRankInputShape } from "./agent-rank.js";
import { agentRecommendHandler, AgentRecommendInputShape } from "./agent-recommend.js";
import { agentRouteForHandler, AgentRouteForInputShape } from "./agent-route-for.js";
import { brainstormHandler, BrainstormInputShape } from "./brainstorm.js";
import { chainCancelHandler, ChainCancelInputShape } from "./chain-cancel.js";
import { chainGetMessagesHandler, ChainGetMessagesInputShape } from "./chain-get-messages.js";
import { chainGetResponseHandler, ChainGetResponseInputShape } from "./chain-get-response.js";
import { chainHistoryHandler, ChainHistoryInputShape } from "./chain-history.js";
import { chainListAgentsHandler, ChainListAgentsInputShape } from "./chain-list-agents.js";
import { chainSendMessageHandler, ChainSendMessageInputShape } from "./chain-send-message.js";
import { chainStartRefinedHandler } from "./chain-start-refined.js";
import { chainStartSimpleHandler, ChainStartSimpleInputShape } from "./chain-start-simple.js";
import {
  chainStartHandler,
  type ChainStartHandlerOpts,
  ChainStartInputShape,
  RegistryUnavailableError,
} from "./chain-start.js";
import { chainStatusHandler, ChainStatusInputShape } from "./chain-status.js";
import { chainWaitHandler, ChainWaitInputShape } from "./chain-wait.js";
import { corpusBuildHandler, CorpusBuildInputShape } from "./corpus-build.js";
import { corpusListHandler, CorpusListInputShape } from "./corpus-list.js";
import { corpusQueryHandler, CorpusQueryInputShape } from "./corpus-query.js";
import {
  COST_QUOTA_STATUS_DESCRIPTION,
  costQuotaStatusHandler,
  CostQuotaStatusInputShape,
} from "./cost-quota-status.js";
import { costRecentHandler, CostRecentInputShape } from "./cost-recent.js";
import {
  DAEMON_RELOAD_CONFIG_DESCRIPTION,
  daemonReloadConfigHandler,
  DaemonReloadConfigInputShape,
} from "./daemon-reload-config.js";
import { dispatchAuditHandler, DispatchAuditInputShape } from "./dispatch-audit.js";
import { dispatchLandHandler, DispatchLandInputShape } from "./dispatch-land.js";
import { dispatchTimelineHandler, DispatchTimelineInputShape } from "./dispatch-timeline.js";
import { dreamingHealthHandler, DreamingHealthInputShape } from "./dreaming-health.js";
import { fleetLatencyHandler, FleetLatencyInputShape } from "./fleet-latency.js";
import { fsEditHandler, FsEditInputShape } from "./fs-edit.js";
import { fsExecHandler, FsExecInputShape } from "./fs-exec.js";
import { fsGlobHandler, FsGlobInputShape } from "./fs-glob.js";
import { fsGrepHandler, FsGrepInputShape } from "./fs-grep.js";
import { fsReadHandler, FsReadInputShape } from "./fs-read.js";
import { fsWriteHandler, FsWriteInputShape } from "./fs-write.js";
import { getObservationsHandler, GetObservationsInputShape } from "./get-observations.js";
import { approveHandoffHandler, ApproveHandoffInputShape } from "./handoff-approve.js";
import { handoffGetHandler, HandoffGetInputShape } from "./handoff-get.js";
import { listHandoffsHandler, ListHandoffsInputShape } from "./handoff-list.js";
import { laneCloseHandler, LaneCloseInputShape } from "./lane-close.js";
import { laneLedgerRecentHandler, LaneLedgerRecentInputShape } from "./lane-ledger-recent.js";
import { laneOpenHandler, LaneOpenInputShape } from "./lane-open.js";
import {
  longLivedApproveActionHandler,
  LongLivedApproveActionInputShape,
} from "./long-lived-approve-action-mcp.js";
import { longLivedAuditHandler, LongLivedAuditInputShape } from "./long-lived-audit-mcp.js";
import { longLivedGetHandler, LongLivedGetInputShape } from "./long-lived-get-mcp.js";
import {
  longLivedInjectGoalHandler,
  LongLivedInjectGoalInputShape,
} from "./long-lived-inject-goal-mcp.js";
import { longLivedListHandler, LongLivedListInputShape } from "./long-lived-list-mcp.js";
import { longLivedPauseHandler, LongLivedPauseInputShape } from "./long-lived-pause-mcp.js";
import {
  longLivedPendingActionsHandler,
  LongLivedPendingActionsInputShape,
} from "./long-lived-pending-actions-mcp.js";
import {
  longLivedRejectActionHandler,
  LongLivedRejectActionInputShape,
} from "./long-lived-reject-action-mcp.js";
import { longLivedResumeHandler, LongLivedResumeInputShape } from "./long-lived-resume-mcp.js";
import { longLivedRetireHandler, LongLivedRetireInputShape } from "./long-lived-retire-mcp.js";
import {
  longLivedSelfPendingActionsHandler,
  LongLivedSelfPendingActionsInputShape,
} from "./long-lived-self-pending-actions-mcp.js";
import {
  longLivedSelfStateGetHandler,
  LongLivedSelfStateGetInputShape,
} from "./long-lived-self-state-get-mcp.js";
import {
  longLivedSelfStateSetHandler,
  LongLivedSelfStateSetInputShape,
} from "./long-lived-self-state-set-mcp.js";
import {
  longLivedStateGetHandler,
  LongLivedStateGetInputShape,
} from "./long-lived-state-get-mcp.js";
import {
  longLivedStateSetHandler,
  LongLivedStateSetInputShape,
} from "./long-lived-state-set-mcp.js";
import { longLivedTickHandler, LongLivedTickInputShape } from "./long-lived-tick-mcp.js";
import { longLivedTicksHandler, LongLivedTicksInputShape } from "./long-lived-ticks-mcp.js";
import {
  maestroCapabilitiesHandler,
  MaestroCapabilitiesInputShape,
} from "./maestro-capabilities.js";
import { maestroSessionGetHandler, MaestroSessionGetInputShape } from "./maestro-session-get.js";
import {
  maestroSessionStartAdhocHandler,
  MaestroSessionStartAdhocInputShape,
} from "./maestro-session-start-adhoc.js";
import {
  maestroSessionStartHandler,
  MaestroSessionStartInputShape,
} from "./maestro-session-start.js";
import {
  memoryCuratorPatternsAddHandler,
  MemoryCuratorPatternsAddInputShape,
} from "./memory-curator-patterns-add.js";
import {
  memoryCuratorPatternsApproveHandler,
  MemoryCuratorPatternsApproveInputShape,
} from "./memory-curator-patterns-approve.js";
import {
  memoryCuratorPatternsDisableHandler,
  MemoryCuratorPatternsDisableInputShape,
} from "./memory-curator-patterns-disable.js";
import {
  memoryCuratorPatternsListHandler,
  MemoryCuratorPatternsListInputShape,
} from "./memory-curator-patterns-list.js";
import {
  memoryDreamActionRevertHandler,
  MemoryDreamActionRevertInputShape,
} from "./memory-dream-action-revert.js";
import {
  memoryEfficacyJobStatusHandler,
  MemoryEfficacyJobStatusInputShape,
} from "./memory-efficacy-job-status.js";
import { memoryEfficacyJobsHandler, MemoryEfficacyJobsInputShape } from "./memory-efficacy-jobs.js";
import {
  memoryEfficacyRebuildHandler,
  MemoryEfficacyRebuildInputShape,
} from "./memory-efficacy-rebuild.js";
import {
  memoryEfficacyRecentHandler,
  MemoryEfficacyRecentInputShape,
} from "./memory-efficacy-recent.js";
import {
  memoryListPendingDreamActionsHandler,
  MemoryListPendingDreamActionsInputShape,
} from "./memory-list-pending-dream-actions.js";
import {
  memoryVerificationEventsHandler,
  MemoryVerificationEventsInputShape,
} from "./memory-verification-events.js";
import {
  memoryVerifyAuthorizeHandler,
  MemoryVerifyAuthorizeInputShape,
} from "./memory-verify-authorize.js";
import { memoryWriteT2Handler, MemoryWriteT2InputShape } from "./memory-write-t2.js";
import { observeHandler, ObserveInputShape } from "./observe.js";
import { permissionApproveHandler, PermissionApproveInputShape } from "./permission-approve.js";
import { permissionGetHandler, PermissionGetInputShape } from "./permission-get.js";
import {
  permissionListPendingHandler,
  PermissionListPendingInputShape,
} from "./permission-list-pending.js";
import { planCancelHandler, PlanCancelInputShape } from "./plan-cancel.js";
import { planListHandler, PlanListInputShape } from "./plan-list.js";
import { planOpenHandler, PlanOpenInputShape } from "./plan-open.js";
import { planStartHandler, PlanStartInputShape } from "./plan-start.js";
import { planStatusHandler, PlanStatusInputShape } from "./plan-status.js";
import { qualityStatusHandler, QualityStatusInputShape } from "./quality-status.js";
import { recallStatusHandler, RecallStatusInputShape } from "./recall-status.js";
import { recallHandler, RecallInputShape } from "./recall.js";
import {
  reconcilerSweepOrphanPrsHandler,
  ReconcilerSweepOrphanPrsInputShape,
} from "./reconciler-sweep-orphan-prs.js";
import { reconcilerVerdictsHandler, ReconcilerVerdictsInputShape } from "./reconciler-verdicts.js";
import { registrarAppendHandler, RegistrarAppendInputShape } from "./registrar-append.js";
import { registrarCreateHandler, RegistrarCreateInputShape } from "./registrar-create.js";
import { registrarListHandler, RegistrarListInputShape } from "./registrar-list.js";
import { registrarStatusHandler, RegistrarStatusInputShape } from "./registrar-status.js";
import { routingBiasClearHandler, RoutingBiasClearInputShape } from "./routing-bias-clear.js";
import { routingBiasListHandler, RoutingBiasListInputShape } from "./routing-bias-list.js";
import { routingBiasSetHandler, RoutingBiasSetInputShape } from "./routing-bias-set.js";
import { searchHandler, SearchInputShape } from "./search.js";
import { sessionEndHandler, SessionEndInputShape } from "./session-end.js";
import {
  sessionEventsRecentHandler,
  SessionEventsRecentInputShape,
} from "./session-events-recent.js";
import { sessionNoteApproveHandler, SessionNoteApproveInputShape } from "./session-note-approve.js";
import { sessionNoteDraftsHandler, SessionNoteDraftsInputShape } from "./session-note-drafts.js";
import { shellCloseHandler, ShellCloseInputShape } from "./shell-close.js";
import { shellListHandler, ShellListInputShape } from "./shell-list.js";
import { shellRunHandler, ShellRunInputShape } from "./shell-run.js";
import {
  subscriptionPressureStatusHandler,
  SubscriptionPressureStatusInputShape,
} from "./subscription-pressure-status.js";
import { taskCancelHandler, TaskCancelInputShape } from "./task-cancel.js";
import { taskCommentGhHandler, TaskCommentGhInputShape } from "./task-comment-gh.js";
import { taskCompleteHandler, TaskCompleteInputShape } from "./task-complete.js";
import {
  taskDraftListPendingEscalationsHandler,
  TaskDraftListPendingEscalationsInputShape,
  taskDraftListPendingHandler,
  TaskDraftListPendingInputShape,
} from "./task-draft.js";
import { taskFailHandler, TaskFailInputShape } from "./task-fail.js";
import { taskFileHandler, TaskFileInputShape } from "./task-file.js";
import { taskGetHandler, TaskGetInputShape } from "./task-get.js";
import { taskHeartbeatHandler, TaskHeartbeatInputShape } from "./task-heartbeat.js";
import { taskLinkGhHandler, TaskLinkGhInputShape } from "./task-link-gh.js";
import { taskListHandler, TaskListInputShape } from "./task-list.js";
import { taskNextHandler, TaskNextInputShape } from "./task-next.js";
import { taskSyncGhNowHandler, TaskSyncGhNowInputShape } from "./task-sync-gh-now.js";
import { taskUnlinkGhHandler, TaskUnlinkGhInputShape } from "./task-unlink-gh.js";
import { timelineHandler, TimelineInputShape } from "./timeline.js";
import { verifyHandler, VerifyInputShape } from "./verify.js";
import { withActingOnEnvelope } from "./with-acting-on.js";
import { workflowHistoryHandler, WorkflowHistoryInputShape } from "./workflow-history.js";
import { workflowListHandler, WorkflowListInputShape } from "./workflow-list.js";
import {
  workflowRunHandler,
  type WorkflowRunHandlerOpts,
  WorkflowRunInputShape,
} from "./workflow-run.js";
import {
  workflowStatusHandler,
  WorkflowStatusInputShape,
  workflowWaitHandler,
  WorkflowWaitInputShape,
} from "./workflow-status.js";
import { workflowSuggestHandler, WorkflowSuggestInputShape } from "./workflow-suggest.js";
import { worktreeCleanupHandler, WorktreeCleanupInputShape } from "./worktree-cleanup.js";
import { worktreeInspectHandler, WorktreeInspectInputShape } from "./worktree-inspect.js";
import { worktreeListHandler, WorktreeListInputShape } from "./worktree-list.js";

interface ToolBuildContext {
  handleStore: HandleStore;
}

export type ToolDescriptor = {
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type ToolDef = {
  descriptor: ToolDescriptor;
  makeHandler: (
    daemon: DaemonClient,
    opts?: unknown,
  ) => (args: unknown, extra?: unknown) => Promise<unknown>;
  readOnly: boolean;
  handlerOpts?: (ctx: ToolBuildContext) => unknown;
};

type ProjectRegistryResolverDeps = {
  cwd: () => string;
  defaultRegistryPath: () => string;
  statPath: (path: string) => { mtimeMs: number };
  loadRegistry: (path: string) => ReturnType<typeof loadProjectRegistry>;
  findProjectId: (
    registry: ReturnType<typeof loadProjectRegistry>,
    cwd: string,
  ) => string | undefined;
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
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

function checkMissingCacheStillValid(
  registryPath: string,
  statPath: ProjectRegistryResolverDeps["statPath"],
): "still_missing" | "invalidate" {
  if (missingProjectRegistryCache?.path !== registryPath) {
    return "invalidate";
  }
  try {
    const parentMtimeMs = statPath(missingProjectRegistryCache.parentDir).mtimeMs;
    if (parentMtimeMs === missingProjectRegistryCache.parentMtimeMs) {
      return "still_missing";
    }
  } catch {
    return "still_missing";
  }
  return "invalidate";
}

function handleMissingRegistry(
  registryPath: string,
  statPath: ProjectRegistryResolverDeps["statPath"],
): void {
  const parentDir = dirname(registryPath);
  let parentMtimeMs = -1;
  try {
    parentMtimeMs = statPath(parentDir).mtimeMs;
  } catch {
    // Keep sentinel -1 when parent dir stats are unavailable.
  }
  missingProjectRegistryCache = { path: registryPath, parentDir, parentMtimeMs };
  cachedProjectRegistry = null;
}

function loadProjectRegistryFromCache(
  registryPath: string,
  deps: Pick<ProjectRegistryResolverDeps, "statPath" | "loadRegistry">,
): ReturnType<typeof loadProjectRegistry> | undefined {
  if (checkMissingCacheStillValid(registryPath, deps.statPath) === "still_missing") {
    return undefined;
  }
  missingProjectRegistryCache = null;

  let mtimeMs: number;
  try {
    mtimeMs = deps.statPath(registryPath).mtimeMs;
  } catch (err) {
    if (isEnoentError(err)) {
      handleMissingRegistry(registryPath, deps.statPath);
      return undefined;
    }
    throw err;
  }

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
  findProjectId?: (
    registry: ReturnType<typeof loadProjectRegistry>,
    cwd: string,
  ) => string | undefined;
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
    const registryPath =
      opts?.registryPath ?? process.env.PENUMBRA_PROJECTS_YAML ?? deps.defaultRegistryPath();
    try {
      const registry = loadProjectRegistryFromCache(registryPath, deps);
      if (registry === undefined) return undefined;
      return deps.findProjectId(registry, deps.cwd());
    } catch (err) {
      logWarn("chain_start.project_registry_unavailable", { registryPath, err });
      const message = err instanceof Error ? err.message : String(err);
      throw new RegistryUnavailableError(message);
    }
  };
}

export function createProjectIdResolverFromPath(opts?: {
  registryPath?: string;
  loadRegistry?: (path: string) => ReturnType<typeof loadProjectRegistry>;
  findProjectId?: (
    registry: ReturnType<typeof loadProjectRegistry>,
    cwd: string,
  ) => string | undefined;
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
    const registryPath =
      opts?.registryPath ?? process.env.PENUMBRA_PROJECTS_YAML ?? deps.defaultRegistryPath();
    try {
      const registry = loadProjectRegistryFromCache(registryPath, deps);
      if (registry === undefined) return undefined;
      return deps.findProjectId(registry, callerCwd);
    } catch (err) {
      logWarn("chain_start.project_registry_unavailable_for_caller_cwd", { registryPath, err });
      const message = err instanceof Error ? err.message : String(err);
      throw new RegistryUnavailableError(message);
    }
  };
}

function logWarn(event: string, data: Record<string, unknown>): void {
  console.warn({ event, ...data });
}

const WorkflowReportInputShape = {
  window_hours: z.number().int().min(1).max(2160).optional(),
  project_id: z.string().min(1).optional(),
};

const WorkflowReportSchema = z.object(WorkflowReportInputShape).strict();

const RAW_TOOL_REGISTRY: Record<string, ToolDef> = {
  memory_observe: {
    descriptor: {
      description: "Record an observation into Penumbra T0.",
      inputSchema: ObserveInputShape,
    },
    makeHandler: observeHandler,
    readOnly: false,
  },
  task_draft_list_pending: {
    descriptor: {
      description:
        "List pending task draft lifecycle events by latest state, oldest-first for FIFO processing.",
      inputSchema: TaskDraftListPendingInputShape,
    },
    makeHandler: taskDraftListPendingHandler,
    readOnly: true,
  },
  task_draft_list_pending_escalations: {
    descriptor: {
      description:
        "List task_drafts whose latest lifecycle event is task_draft_escalation, joined back to the original draft payload. Used by the escalation refiner tier.",
      inputSchema: TaskDraftListPendingEscalationsInputShape,
    },
    makeHandler: taskDraftListPendingEscalationsHandler,
    readOnly: true,
  },
  memory_recall: {
    descriptor: {
      description: "Retrieve top-K memories (T1+T2) by semantic similarity.",
      inputSchema: RecallInputShape,
    },
    makeHandler: recallHandler,
    readOnly: true,
  },
  memory_search: {
    descriptor: {
      description:
        "Step 1 of 3-layer recall: compact index of memory hits (id + title + snippet + score) over t1_fts/t2_fts with metadata filters. Cheap to scan; pair with memory_timeline + memory_get_observations.",
      inputSchema: SearchInputShape,
    },
    makeHandler: searchHandler,
    readOnly: true,
  },
  memory_verify: {
    descriptor: {
      description: "Mark a t2 memory as verified and update its freshness metadata.",
      inputSchema: VerifyInputShape,
    },
    makeHandler: verifyHandler,
    readOnly: false,
  },
  memory_verify_authorize: {
    descriptor: {
      description:
        "Authorize memory verification with basis validation and record the authorization provenance.",
      inputSchema: MemoryVerifyAuthorizeInputShape,
    },
    makeHandler: memoryVerifyAuthorizeHandler,
    readOnly: false,
  },
  memory_write_t2: {
    descriptor: {
      description:
        "Write a direct T2 memory from maestro/CLI principals (rejected for worker-token callers), requiring slug and hook, with optional backlink parsing.",
      inputSchema: MemoryWriteT2InputShape,
    },
    makeHandler: memoryWriteT2Handler,
    readOnly: false,
  },
  memory_timeline: {
    descriptor: {
      description:
        "Step 2 of 3-layer recall: chronological neighbors around an anchor t2 memory. Use to see what was happening just before/after a hit.",
      inputSchema: TimelineInputShape,
    },
    makeHandler: timelineHandler,
    readOnly: true,
  },
  memory_get_observations: {
    descriptor: {
      description:
        "Step 3 of 3-layer recall: hydrate full bodies for IDs returned by memory_search or memory_timeline. Always batch — do not call once per ID.",
      inputSchema: GetObservationsInputShape,
    },
    makeHandler: getObservationsHandler,
    readOnly: true,
  },
  memory_corpus_build: {
    descriptor: {
      description:
        "Build (or rebuild by name) a knowledge corpus: a named, persisted bundle of t2 observations matching a metadata filter (project_id / obs_type / concept / file_path / date range). Use as a topical RAG slice that survives across recalls.",
      inputSchema: CorpusBuildInputShape,
    },
    makeHandler: corpusBuildHandler,
    readOnly: false,
  },
  memory_corpus_query: {
    descriptor: {
      description:
        "Vector-rerank a query against members of a named corpus only. Returns the same hit shape as memory_search but constrained to the corpus.",
      inputSchema: CorpusQueryInputShape,
    },
    makeHandler: corpusQueryHandler,
    readOnly: true,
  },
  memory_corpus_list: {
    descriptor: {
      description: "List all knowledge corpora with their member counts and creation timestamps.",
      inputSchema: CorpusListInputShape,
    },
    makeHandler: corpusListHandler,
    readOnly: true,
  },
  memory_efficacy_recent: {
    descriptor: {
      description:
        "Recent-window read of how often reviewer findings indicate a memory failure mode (missed_registration / recall_miss / memory_ignored / not_memory_related).",
      inputSchema: MemoryEfficacyRecentInputShape,
    },
    makeHandler: memoryEfficacyRecentHandler,
    readOnly: true,
  },
  memory_verification_events: {
    descriptor: {
      description:
        "Read the audit trail for a verified memory, including verifier identity, claimed-by provenance, reason, and timestamp.",
      inputSchema: MemoryVerificationEventsInputShape,
    },
    makeHandler: memoryVerificationEventsHandler,
    readOnly: true,
  },
  quality_status: {
    descriptor: {
      description:
        "Composite quality snapshot spanning lane health, adversarial review outcomes, agent recommendations, memory efficacy, and subscription pressure.",
      inputSchema: QualityStatusInputShape,
    },
    makeHandler: qualityStatusHandler,
    readOnly: true,
  },
  memory_efficacy_rebuild: {
    descriptor: {
      description:
        "Enqueue an async rebuild of the memory_efficacy_cache by scanning review syntheses and classifying findings via Sirius LLM. Returns {job_id, status} for tracking with memory_efficacy_job_status.",
      inputSchema: MemoryEfficacyRebuildInputShape,
    },
    makeHandler: memoryEfficacyRebuildHandler,
    readOnly: false,
  },
  memory_efficacy_job_status: {
    descriptor: {
      description: "Check the status of an async memory_efficacy_rebuild job.",
      inputSchema: MemoryEfficacyJobStatusInputShape,
    },
    makeHandler: memoryEfficacyJobStatusHandler,
    readOnly: true,
  },
  memory_efficacy_jobs: {
    descriptor: {
      description: "List recent memory_efficacy_rebuild jobs with optional status filter.",
      inputSchema: MemoryEfficacyJobsInputShape,
    },
    makeHandler: memoryEfficacyJobsHandler,
    readOnly: true,
  },
  workflow_list: {
    descriptor: {
      description: "List registered workflows with their triggers and descriptions.",
      inputSchema: WorkflowListInputShape,
    },
    makeHandler: workflowListHandler,
    readOnly: true,
  },
  workflow_run: {
    descriptor: {
      description: "Run a registered workflow by name.",
      inputSchema: WorkflowRunInputShape,
    },
    makeHandler: workflowRunHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (_ctx) => ({ resolveCwd: () => process.cwd() }) satisfies WorkflowRunHandlerOpts,
    readOnly: false,
  },
  workflow_status: {
    descriptor: {
      description:
        "Check the status of an async workflow run. Returns run state only — { status, started_at, finished_at?, result_available, result_bytes, error_bytes }; result/error payloads are NOT included. Use workflow_wait for the full result.",
      inputSchema: WorkflowStatusInputShape,
    },
    makeHandler: workflowStatusHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  workflow_wait: {
    descriptor: {
      description:
        "Block until an async workflow run reaches a terminal state or times out. On truncation, result/error is null, result_preview/error_preview contains a bounded string preview, and result_handle_id/error_handle_id can be resolved with read_handle.",
      inputSchema: WorkflowWaitInputShape,
    },
    makeHandler: workflowWaitHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: true,
  },
  workflow_suggest: {
    descriptor: {
      description: "Suggest workflows matching current state thresholds.",
      inputSchema: WorkflowSuggestInputShape,
    },
    makeHandler: workflowSuggestHandler,
    readOnly: true,
  },
  workflow_history: {
    descriptor: {
      description: "Past run stats + recent outcomes for a named workflow.",
      inputSchema: WorkflowHistoryInputShape,
    },
    makeHandler: workflowHistoryHandler,
    readOnly: true,
  },
  workflow_report: {
    descriptor: {
      description:
        "Read workflow outcome aggregates and workflow-dispatch spend/reliability for a recent window.",
      inputSchema: WorkflowReportInputShape,
    },
    makeHandler: (daemon) => async (input) =>
      toTextContent(await daemon.workflowReport(WorkflowReportSchema.parse(input))),
    readOnly: true,
  },
  brainstorm: {
    descriptor: {
      description: "Run the brainstorm workflow with topic and optional constraints.",
      inputSchema: BrainstormInputShape,
    },
    makeHandler: brainstormHandler,
    readOnly: false,
  },
  plan_open: {
    descriptor: {
      description:
        "Open a plan from a goal and optional steps by generating a minimal plan file and registering it.",
      inputSchema: PlanOpenInputShape,
    },
    makeHandler: planOpenHandler,
    readOnly: false,
  },
  lane_open: {
    descriptor: {
      description: "Open a lane for an implementer handoff and task class.",
      inputSchema: LaneOpenInputShape,
    },
    makeHandler: laneOpenHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  lane_close: {
    descriptor: {
      description:
        "Close a lane with a reviewer outcome. Pass reviewer_handoff_id on passed/failed closes when a reviewer handoff exists — without it the memory-verify authorization step is skipped (surfaced as memory_verify_authorization in the result).",
      inputSchema: LaneCloseInputShape,
    },
    makeHandler: laneCloseHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  lane_ledger_recent: {
    descriptor: {
      description: "Fetch recent lanes with optional filters.",
      inputSchema: LaneLedgerRecentInputShape,
    },
    makeHandler: laneLedgerRecentHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  memory_status: {
    descriptor: {
      description:
        "Recall corpus health snapshot: tier counts (t0/t1/t2), t2 obs_type/severity histograms, t1 promotion backlog (unpromoted + failed), corpora count, and last recall_audit timestamp.",
      inputSchema: RecallStatusInputShape,
    },
    makeHandler: recallStatusHandler,
    readOnly: true,
  },
  long_lived_list: {
    descriptor: {
      description: "List non-retired long-lived operators.",
      inputSchema: LongLivedListInputShape,
    },
    makeHandler: longLivedListHandler,
    readOnly: true,
  },
  long_lived_get: {
    descriptor: {
      description: "Get full long-lived operator details.",
      inputSchema: LongLivedGetInputShape,
    },
    makeHandler: longLivedGetHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  long_lived_pause: {
    descriptor: {
      description: "Pause a long-lived operator.",
      inputSchema: LongLivedPauseInputShape,
    },
    makeHandler: longLivedPauseHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_resume: {
    descriptor: {
      description: "Resume a paused long-lived operator.",
      inputSchema: LongLivedResumeInputShape,
    },
    makeHandler: longLivedResumeHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_retire: {
    descriptor: {
      description: "Retire a long-lived operator.",
      inputSchema: LongLivedRetireInputShape,
    },
    makeHandler: longLivedRetireHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_tick: {
    descriptor: {
      description: "Manually trigger a long-lived operator tick.",
      inputSchema: LongLivedTickInputShape,
    },
    makeHandler: longLivedTickHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_state_get: {
    descriptor: {
      description: "Get a long-lived operator working memory snapshot.",
      inputSchema: LongLivedStateGetInputShape,
    },
    makeHandler: longLivedStateGetHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  long_lived_state_set: {
    descriptor: {
      description: "Update a long-lived operator working memory snapshot.",
      inputSchema: LongLivedStateSetInputShape,
    },
    makeHandler: longLivedStateSetHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_pending_actions: {
    descriptor: {
      description: "List pending actions for a long-lived operator.",
      inputSchema: LongLivedPendingActionsInputShape,
    },
    makeHandler: longLivedPendingActionsHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  long_lived_self_state_get: {
    descriptor: {
      description: "Get this long-lived agent working memory snapshot.",
      inputSchema: LongLivedSelfStateGetInputShape,
    },
    makeHandler: longLivedSelfStateGetHandler,
    readOnly: true,
  },
  long_lived_self_state_set: {
    descriptor: {
      description: "Update this long-lived agent working memory snapshot.",
      inputSchema: LongLivedSelfStateSetInputShape,
    },
    makeHandler: longLivedSelfStateSetHandler,
    readOnly: false,
  },
  long_lived_self_pending_actions: {
    descriptor: {
      description: "List pending actions for this long-lived agent.",
      inputSchema: LongLivedSelfPendingActionsInputShape,
    },
    makeHandler: longLivedSelfPendingActionsHandler,
    readOnly: true,
  },
  long_lived_approve_action: {
    descriptor: {
      description: "Approve a pending long-lived action.",
      inputSchema: LongLivedApproveActionInputShape,
    },
    makeHandler: longLivedApproveActionHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_reject_action: {
    descriptor: {
      description: "Reject a pending long-lived action.",
      inputSchema: LongLivedRejectActionInputShape,
    },
    makeHandler: longLivedRejectActionHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_inject_goal: {
    descriptor: {
      description: "Inject a goal into a long-lived operator.",
      inputSchema: LongLivedInjectGoalInputShape,
    },
    makeHandler: longLivedInjectGoalHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  long_lived_audit: {
    descriptor: {
      description: "Read long-lived action audit rows.",
      inputSchema: LongLivedAuditInputShape,
    },
    makeHandler: longLivedAuditHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  long_lived_ticks: {
    descriptor: {
      description: "Read long-lived tick rows.",
      inputSchema: LongLivedTicksInputShape,
    },
    makeHandler: longLivedTicksHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  cost_recent: {
    descriptor: {
      description:
        "Returns the recent cost ledger summary (totals + by_provider) over a 24h-default window.",
      inputSchema: CostRecentInputShape,
    },
    makeHandler: costRecentHandler,
    readOnly: true,
  },
  cost_quota_status: {
    descriptor: {
      description: COST_QUOTA_STATUS_DESCRIPTION,
      inputSchema: CostQuotaStatusInputShape,
    },
    makeHandler: costQuotaStatusHandler,
    readOnly: true,
  },
  subscription_pressure_status: {
    descriptor: {
      description:
        "Per-(provider, window_label) subscription rate-limit snapshots aggregated from t0_events. Replaces fictional USD readouts for subscription agents.",
      inputSchema: SubscriptionPressureStatusInputShape,
    },
    makeHandler: subscriptionPressureStatusHandler,
    readOnly: true,
  },
  routing_bias_list: {
    descriptor: {
      description:
        "List active routing biases with human-readable time_remaining. Optionally filter by scope or value.",
      inputSchema: RoutingBiasListInputShape,
    },
    makeHandler: routingBiasListHandler,
    readOnly: true,
  },
  routing_bias_set: {
    descriptor: {
      description:
        "Set a routing bias (boost, divert, exclude) for an agent or provider. Idempotent at the (scope, value, mode) key.",
      inputSchema: RoutingBiasSetInputShape,
    },
    makeHandler: routingBiasSetHandler,
    readOnly: false,
  },
  routing_bias_clear: {
    descriptor: {
      description:
        "Clear routing biases by bias_id, (scope + value), or all:true with confirm:true guard.",
      inputSchema: RoutingBiasClearInputShape,
    },
    makeHandler: routingBiasClearHandler,
    readOnly: false,
  },
  agent_rank: {
    descriptor: {
      description:
        "Rank agents for a task type using captured dispatch outcome, cost, and latency data.",
      inputSchema: AgentRankInputShape,
    },
    makeHandler: agentRankHandler,
    readOnly: true,
  },
  fleet_latency: {
    descriptor: {
      description:
        "Read per-agent dispatch execution latency and throughput from dispatch_events over a recent window, plus current approved/dispatched queue depth.",
      inputSchema: FleetLatencyInputShape,
    },
    makeHandler: fleetLatencyHandler,
    readOnly: true,
  },
  agent_recommend: {
    descriptor: {
      description:
        "Recommend agents for a task type ranked by recent performance. Inputs: task_type (required), risk_class (optional), window_days (optional, default 7).",
      inputSchema: AgentRecommendInputShape,
    },
    makeHandler: agentRecommendHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  agent_route_for: {
    descriptor: {
      description:
        "Route a task role to the best eligible agent using role allowlists, pressure state, and recent performance.",
      inputSchema: AgentRouteForInputShape,
    },
    makeHandler: agentRouteForHandler,
    readOnly: true,
  },
  plan_start: {
    descriptor: {
      description: "Register a plan file with the daemon and return its plan_id and status.",
      inputSchema: PlanStartInputShape,
    },
    makeHandler: planStartHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  plan_list: {
    descriptor: {
      description: "List registered plans, optionally filtered by status.",
      inputSchema: PlanListInputShape,
    },
    makeHandler: planListHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  plan_status: {
    descriptor: {
      description: "Return a plan and its hydrated task records by plan_id.",
      inputSchema: PlanStatusInputShape,
    },
    makeHandler: planStatusHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  plan_cancel: {
    descriptor: {
      description: "Cancel a registered plan by plan_id.",
      inputSchema: PlanCancelInputShape,
    },
    makeHandler: planCancelHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  registrar_create: {
    descriptor: {
      description: "Create a registrar entry and return its registrar_id and status.",
      inputSchema: RegistrarCreateInputShape,
    },
    makeHandler: registrarCreateHandler,
    readOnly: false,
  },
  registrar_append: {
    descriptor: {
      description: "Append a validated event to a registrar entry.",
      inputSchema: RegistrarAppendInputShape,
    },
    makeHandler: registrarAppendHandler,
    readOnly: false,
  },
  registrar_list: {
    descriptor: {
      description: "List registrar entries.",
      inputSchema: RegistrarListInputShape,
    },
    makeHandler: registrarListHandler,
    readOnly: true,
  },
  registrar_status: {
    descriptor: {
      description: "Return a registrar entry with phases, events, and rollup status.",
      inputSchema: RegistrarStatusInputShape,
    },
    makeHandler: registrarStatusHandler,
    readOnly: true,
  },
  session_end: {
    descriptor: {
      description:
        "Trigger a synchronous T1 rollup for the named session. Returns the rollup_id, or null if there was nothing to roll up (already rolled up or no events).",
      inputSchema: SessionEndInputShape,
    },
    makeHandler: sessionEndHandler,
    readOnly: false,
  },
  handoff_list_pending: {
    descriptor: {
      description: "List pending agent handoffs awaiting approval.",
      inputSchema: ListHandoffsInputShape,
    },
    makeHandler: listHandoffsHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  handoff_approve: {
    descriptor: {
      description: "Approve, redirect, or reject a pending handoff.",
      inputSchema: ApproveHandoffInputShape,
    },
    makeHandler: approveHandoffHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  handoff_get: {
    descriptor: {
      description: "Returns the current state of a single handoff.",
      inputSchema: HandoffGetInputShape,
    },
    makeHandler: handoffGetHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  dispatch_timeline: {
    descriptor: {
      description: "Returns the ordered dispatch_events timeline for a handoff_id.",
      inputSchema: DispatchTimelineInputShape,
    },
    makeHandler: dispatchTimelineHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  session_events: {
    descriptor: {
      description:
        "Returns recent session_events rows filtered by session_id, kind_prefix, or since.",
      inputSchema: SessionEventsRecentInputShape,
    },
    makeHandler: sessionEventsRecentHandler,
    readOnly: true,
  },
  session_note_drafts: {
    descriptor: {
      description: "List session note drafts awaiting operator approval or filtered by status.",
      inputSchema: SessionNoteDraftsInputShape,
    },
    makeHandler: sessionNoteDraftsHandler,
    readOnly: true,
  },
  session_note_approve: {
    descriptor: {
      description: "Approve a drafted session note and publish it to the bare note path.",
      inputSchema: SessionNoteApproveInputShape,
    },
    makeHandler: sessionNoteApproveHandler,
    readOnly: false,
  },
  dispatch_audit: {
    descriptor: {
      description: "Return a reliability audit report for one handoff.",
      inputSchema: DispatchAuditInputShape,
    },
    makeHandler: dispatchAuditHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  dispatch_land: {
    descriptor: {
      description:
        "Land the handoff's recorded branch_name via curated squash or ff-only flow. Missing/error verdicts can auto-pass with dispatch_audit trustworthy+accept; explicit typecheck/tests fail at the branch head requires force.",
      inputSchema: DispatchLandInputShape,
    },
    makeHandler: dispatchLandHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  permission_list_pending: {
    descriptor: {
      description:
        "List pending tool-permission requests awaiting operator approval. Optional filters: conversation_id, parent_handoff_id, status (comma-separated).",
      inputSchema: PermissionListPendingInputShape,
    },
    makeHandler: permissionListPendingHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  permission_get: {
    descriptor: {
      description:
        "Returns a single permission_request row including raw_input_json for operator review before deciding.",
      inputSchema: PermissionGetInputShape,
    },
    makeHandler: permissionGetHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  permission_approve: {
    descriptor: {
      description:
        'Approve or reject a pending permission_request. remember="this_dispatch" auto-approves subsequent calls of the same tool within this dispatch.',
      inputSchema: PermissionApproveInputShape,
    },
    makeHandler: permissionApproveHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  chain_status: {
    descriptor: {
      description:
        "Returns lean status for a handoff: { status, error_summary, worker_id, latency_seconds }. ~30x cheaper than handoff_get for routine polling.",
      inputSchema: ChainStatusInputShape,
    },
    makeHandler: chainStatusHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  chain_start: {
    descriptor: {
      description:
        "Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches the chain headlessly. Poll handoff_list_pending to monitor.",
      inputSchema: ChainStartInputShape,
    },
    makeHandler: chainStartHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (_ctx) =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_start_simple: {
    descriptor: {
      description:
        "Minimal-schema wrapper for chain_start. Takes {initial_agent, message[, project_id]}; hardcodes task_class=STANDARD, task_type=debug_diagnose, use_worktree=false, max_hops=2, trust_mode=config. Set PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=1 requires project_id.",
      inputSchema: ChainStartSimpleInputShape,
    },
    makeHandler: chainStartSimpleHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (_ctx) =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_start_refined: {
    descriptor: {
      description:
        'Same schema as chain_start, but reshapes `message` through a fast LLM refiner before dispatch. Use when a dispatch is at risk of being misread by the target agent as session-bootstrap context, brainstorming material, or an approval ask. The refiner rewrites the message into imperative-first shape (no top-level markdown headers, leading verb, explicit "Design approved — execute end-to-end" framing when applicable). Input is zod-validated against the full chain_start schema BEFORE the refiner is called, so malformed inputs fail fast without LLM cost. Adds ~5-15s for the refiner call. Requires PENUMBRA_JUDGE_BASE_URL on the daemon; route returns 503 if unconfigured.',
      inputSchema: ChainStartInputShape,
    },
    makeHandler: chainStartRefinedHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (_ctx) =>
      ({
        resolveProjectIdFromCwd: createProjectIdResolverFromCwd(),
        resolveProjectIdFromPath: createProjectIdResolverFromPath(),
      }) satisfies ChainStartHandlerOpts,
    readOnly: false,
  },
  chain_wait: {
    descriptor: {
      description:
        "Block until the conversation reaches a terminal state (completed or failed) or timeout.",
      inputSchema: ChainWaitInputShape,
    },
    makeHandler: chainWaitHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  chain_cancel: {
    descriptor: {
      description: "Request cancellation of an in-flight handoff by handoff_id.",
      inputSchema: ChainCancelInputShape,
    },
    makeHandler: chainCancelHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  chain_send_message: {
    descriptor: {
      description:
        "Inject a user-text message into a live ACP child dispatch. Use to answer questions a child agent has emitted while waiting for input. Requires the dispatch to still be running and the agent to be on a mid-session-inject-capable adapter (stdio-acp, claude-acp*, codex-acp).",
      inputSchema: ChainSendMessageInputShape,
    },
    makeHandler: chainSendMessageHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  chain_history: {
    descriptor: {
      description:
        "DEPRECATED. Returns only `chain-terminated` events. Use `chain_get_messages` for the full conversation log, or `chain_get_response` for just the agent's text. Kept for backward compatibility.",
      inputSchema: ChainHistoryInputShape,
    },
    makeHandler: chainHistoryHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  chain_get_messages: {
    descriptor: {
      description:
        "Returns all events for a given conversation_id. Optionally filter by types array.",
      inputSchema: ChainGetMessagesInputShape,
    },
    makeHandler: chainGetMessagesHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  chain_list_agents: {
    descriptor: {
      description: "Returns the valid agent names from the loaded agentchat registry.",
      inputSchema: ChainListAgentsInputShape,
    },
    makeHandler: chainListAgentsHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  chain_get_response: {
    descriptor: {
      description:
        'Returns the agent responses for a given conversation_id. which="final" returns the most recent response. which="all" returns all responses chronologically.',
      inputSchema: ChainGetResponseInputShape,
    },
    makeHandler: chainGetResponseHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  worktree_list: {
    descriptor: {
      description: "Returns all currently-tracked worktrees from the manager.",
      inputSchema: WorktreeListInputShape,
    },
    makeHandler: worktreeListHandler,
    readOnly: true,
  },
  worktree_inspect: {
    descriptor: {
      description: "Returns the diff and branch log for a specific worktree.",
      inputSchema: WorktreeInspectInputShape,
    },
    makeHandler: worktreeInspectHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  worktree_cleanup: {
    descriptor: {
      description: "Tears down a worktree by handoff ID.",
      inputSchema: WorktreeCleanupInputShape,
    },
    makeHandler: worktreeCleanupHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  fs_glob: {
    descriptor: {
      description:
        'Find files inside the dispatch\'s worktree by glob pattern (e.g. "**/*.ts"). Honors .gitignore by default. Sorted by mtime desc. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGlobInputShape,
    },
    makeHandler: fsGlobHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: true,
  },
  fs_grep: {
    descriptor: {
      description:
        'Search file contents in the dispatch\'s worktree using ripgrep. Two output modes: "content" returns {path, line, text} rows (default; cap 50/ceiling 500); "files_with_matches" returns paths only (cap 1000/ceiling 5000). handoff_id defaults to PENUMBRA_HANDOFF_ID env var.',
      inputSchema: FsGrepInputShape,
    },
    makeHandler: fsGrepHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: true,
  },
  fs_read: {
    descriptor: {
      description:
        "Read a single file's content scoped to a dispatch worktree. Returns {content, path, bytes, truncated}. Files larger than 1 MiB are truncated. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.",
      inputSchema: FsReadInputShape,
    },
    makeHandler: fsReadHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: true,
  },
  fs_write: {
    descriptor: {
      description:
        "Create or overwrite a single file scoped to a dispatch worktree. Creates missing parent directories. Writes atomically (temp-then-rename). Returns {path, bytes_written, created}. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.",
      inputSchema: FsWriteInputShape,
    },
    makeHandler: fsWriteHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: false,
  },
  fs_edit: {
    descriptor: {
      description:
        "Perform an exact string-replace edit on an existing file scoped to a dispatch worktree. Writes atomically (temp-then-rename). Returns {path, replacements}. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.",
      inputSchema: FsEditInputShape,
    },
    makeHandler: fsEditHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: false,
  },
  fs_exec: {
    descriptor: {
      description:
        "Run a shell command scoped to a dispatch worktree (cwd is the worktree root). Dangerous-command patterns are blocked before execution. Returns {stdout, stderr, exit_code, timed_out, truncated}. handoff_id defaults to PENUMBRA_HANDOFF_ID env var.",
      inputSchema: FsExecInputShape,
    },
    makeHandler: fsExecHandler as unknown as ToolDef["makeHandler"],
    handlerOpts: (ctx?: ToolBuildContext) => ({ handleStore: ctx?.handleStore }),
    readOnly: false,
  },
  daemon_reload_config: {
    descriptor: {
      description: DAEMON_RELOAD_CONFIG_DESCRIPTION,
      inputSchema: DaemonReloadConfigInputShape,
    },
    makeHandler: daemonReloadConfigHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  reconciler_sweep_orphan_prs: {
    descriptor: {
      description:
        "Manually run the reconciler PR orphan sweeper. Scans open fleet PRs by handoff branch_name membership plus legacy agent/<uuid> fallback, classifies superseded/stale, and closes according to dry_run/max_close.",
      inputSchema: ReconcilerSweepOrphanPrsInputShape,
    },
    makeHandler: reconcilerSweepOrphanPrsHandler as unknown as ToolDef["makeHandler"],
    readOnly: false,
  },
  reconciler_verdicts: {
    descriptor: {
      description:
        "List recent reconciler verdict events joined with handoff metadata. Useful for review/landing queues.",
      inputSchema: ReconcilerVerdictsInputShape,
    },
    makeHandler: reconcilerVerdictsHandler as unknown as ToolDef["makeHandler"],
    readOnly: true,
  },
  shell_run: {
    descriptor: {
      description: "Run a shell command inside a dispatch shell session.",
      inputSchema: ShellRunInputShape,
    },
    makeHandler: shellRunHandler,
    readOnly: false,
  },
  shell_close: {
    descriptor: {
      description: "Close a dispatch shell session.",
      inputSchema: ShellCloseInputShape,
    },
    makeHandler: shellCloseHandler,
    readOnly: false,
  },
  shell_list: {
    descriptor: {
      description: "List active dispatch shell sessions.",
      inputSchema: ShellListInputShape,
    },
    makeHandler: shellListHandler,
    readOnly: true,
  },
  task_file: {
    descriptor: {
      description:
        "Create a new task on the task board. When gh_create is provided, GitHub issue creation is queued asynchronously (check task_get gh_create_status/gh_create_error).",
      inputSchema: TaskFileInputShape,
    },
    makeHandler: taskFileHandler,
    readOnly: false,
  },
  task_list: {
    descriptor: {
      description: "List tasks with optional status/kind/eligibility/origin filters.",
      inputSchema: TaskListInputShape,
    },
    makeHandler: taskListHandler,
    readOnly: true,
  },
  task_get: {
    descriptor: {
      description: "Get one task by id with optional lease/events/descendants expansions.",
      inputSchema: TaskGetInputShape,
    },
    makeHandler: taskGetHandler,
    readOnly: true,
  },
  maestro_session_get: {
    descriptor: {
      description: "Get one maestro session by task id, or null if no session row exists.",
      inputSchema: MaestroSessionGetInputShape,
    },
    makeHandler: maestroSessionGetHandler,
    readOnly: true,
  },
  maestro_session_start: {
    descriptor: {
      description:
        "Create a maestro session row for an orchestrate task with explicit maestro agent and budgets.",
      inputSchema: MaestroSessionStartInputShape,
    },
    makeHandler: maestroSessionStartHandler,
    readOnly: false,
  },
  maestro_session_start_adhoc: {
    descriptor: {
      description:
        "Create an orchestrate task and synchronously dispatch a pre-bound maestro session in one call.",
      inputSchema: MaestroSessionStartAdhocInputShape,
    },
    makeHandler: maestroSessionStartAdhocHandler,
    readOnly: false,
  },
  maestro_capabilities: {
    descriptor: {
      description:
        "Return canonical maestro capabilities: dispatchable agents, task types, and workflow names.",
      inputSchema: MaestroCapabilitiesInputShape,
    },
    makeHandler: maestroCapabilitiesHandler,
    readOnly: true,
  },
  task_next: {
    descriptor: {
      description:
        "Lease the highest-priority eligible task for the provided agent, or null when none are available.",
      inputSchema: TaskNextInputShape,
    },
    makeHandler: taskNextHandler,
    readOnly: true,
  },
  task_heartbeat: {
    descriptor: {
      description: "Heartbeat an active task lease.",
      inputSchema: TaskHeartbeatInputShape,
    },
    makeHandler: taskHeartbeatHandler,
    readOnly: false,
  },
  task_complete: {
    descriptor: {
      description: "Complete a leased task and persist its result payload.",
      inputSchema: TaskCompleteInputShape,
    },
    makeHandler: taskCompleteHandler,
    readOnly: false,
  },
  task_fail: {
    descriptor: {
      description: "Fail a leased task with a reason.",
      inputSchema: TaskFailInputShape,
    },
    makeHandler: taskFailHandler,
    readOnly: false,
  },
  task_cancel: {
    descriptor: {
      description: "Cancel a task by id.",
      inputSchema: TaskCancelInputShape,
    },
    makeHandler: taskCancelHandler,
    readOnly: false,
  },
  task_link_gh: {
    descriptor: {
      description: "Link a task to a GitHub issue and enqueue async sync.",
      inputSchema: TaskLinkGhInputShape,
    },
    makeHandler: taskLinkGhHandler,
    readOnly: false,
  },
  task_comment_gh: {
    descriptor: {
      description: "Post a manual mirrored comment to the linked GitHub issue for this task.",
      inputSchema: TaskCommentGhInputShape,
    },
    makeHandler: taskCommentGhHandler,
    readOnly: false,
  },
  task_unlink_gh: {
    descriptor: {
      description: "Unlink a task from GitHub issue metadata without changing issue state.",
      inputSchema: TaskUnlinkGhInputShape,
    },
    makeHandler: taskUnlinkGhHandler,
    readOnly: false,
  },
  task_sync_gh_now: {
    descriptor: {
      description: "Sync one linked task (or all linked tasks) against GitHub issue state now.",
      inputSchema: TaskSyncGhNowInputShape,
    },
    makeHandler: taskSyncGhNowHandler,
    readOnly: false,
  },
  memory_list_pending_dream_actions: {
    descriptor: {
      description:
        "List dream_actions awaiting human review (status queued or approved). Returns actions with untrusted_source flag and oldest_pending_age_hours computed from cycle started_at.",
      inputSchema: MemoryListPendingDreamActionsInputShape,
    },
    makeHandler: memoryListPendingDreamActionsHandler,
    readOnly: true,
  },
  memory_dream_action_revert: {
    descriptor: {
      description:
        "Revert a dream action with optional cascade dependency resolution. P1 promote_t1: un-promotes t1 rollup and retires minted t2. P2 link: retires memory_links row. P3 retire: un-retires t2 memory. P6 brief: deletes project_briefs row (gated by generated_at <= decided_at). P7 reembed: restores prior embedding vector from t2_vec_history. Other phases (P3 rewrite, P4, P5): stamp reverted_by only (no state change). cascade=none refuses with 409 has_dependents when other auto_applied actions reference this action via payload_json.source_action_id. cascade=force recurses topologically (children first).",
      inputSchema: MemoryDreamActionRevertInputShape,
    },
    makeHandler: memoryDreamActionRevertHandler,
    readOnly: false,
  },
  dreaming_health: {
    descriptor: {
      description: "Get dreaming health status including running cycles and alerts.",
      inputSchema: DreamingHealthInputShape,
    },
    makeHandler: dreamingHealthHandler,
    readOnly: true,
  },
  memory_curator_patterns_list: {
    descriptor: {
      description: "List curator ephemera patterns. Default status=approved.",
      inputSchema: MemoryCuratorPatternsListInputShape,
    },
    makeHandler: memoryCuratorPatternsListHandler,
    readOnly: true,
  },
  memory_curator_patterns_add: {
    descriptor: {
      description: "Propose a new curator ephemera pattern (status=queued, enabled=0).",
      inputSchema: MemoryCuratorPatternsAddInputShape,
    },
    makeHandler: memoryCuratorPatternsAddHandler,
    readOnly: false,
  },
  memory_curator_patterns_approve: {
    descriptor: {
      description: "Approve a queued ephemera pattern (sets status=approved, enabled=1).",
      inputSchema: MemoryCuratorPatternsApproveInputShape,
    },
    makeHandler: memoryCuratorPatternsApproveHandler,
    readOnly: false,
  },
  memory_curator_patterns_disable: {
    descriptor: {
      description: "Disable an approved ephemera pattern (sets enabled=0; keeps history).",
      inputSchema: MemoryCuratorPatternsDisableInputShape,
    },
    makeHandler: memoryCuratorPatternsDisableHandler,
    readOnly: false,
  },
};

export const TOOL_REGISTRY: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(RAW_TOOL_REGISTRY).map(([name, def]) => [
    name,
    {
      ...def,
      makeHandler: (daemon: DaemonClient, opts?: unknown) =>
        withActingOnEnvelope(def.makeHandler(daemon, def.handlerOpts?.(opts as ToolBuildContext))),
    } satisfies ToolDef,
  ]),
);
