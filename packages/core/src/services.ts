import type { ModelAliasMap, TaskRouterConfig } from "@penumbra/config";

import { Database } from "bun:sqlite";
import { resolve as pathResolve } from "node:path";

import type { Embedder } from "./embedder/interface.js";
import type { ProjectRegistry } from "./projects/registry.js";
import type { ProviderQuota } from "./readers/cost-quota.js";
import type { HandoffRow } from "./schemas/handoff.js";
import type { WorkerSupervisor } from "./supervisor/interface.js";
import type { TaskCooldowns } from "./tasks/cooldowns.js";
import type { WorkflowRegistry } from "./workflows/registry-interface.js";

import { DbMeta } from "./db/meta.js";
import { DispatchEventBus } from "./dispatch/event-bus.js";
import { ConversationStreamBus } from "./events/conversation-stream.js";
import { HandoffEventBus } from "./events/handoff-events.js";
import { HandoffTransitionBus } from "./events/handoff-transitions.js";
import { PermissionEventBus } from "./events/permission-events.js";
import { WorkerControlBus } from "./events/worker-control.js";
import { MachineId } from "./identity/machine-id.js";
import { ProjectCache } from "./identity/project-cache.js";
import { createLogger, type Logger } from "./logger.js";
import {
  createSubscriptionPressureCache,
  type SubscriptionPressureCache,
} from "./maestro/subscription-pressure-cache.js";
import { MaestroSessionWriter } from "./maestro/writer.js";
import { PidRegistry } from "./pid/registry.js";
import { PlanWriter } from "./plans/writer.js";
import { ChainReader } from "./readers/chain.js";
import { HandoffReader } from "./readers/handoff.js";
import { PermissionReader } from "./readers/permission.js";
import { RecallReader } from "./readers/recall.js";
import { TaskDraftReader } from "./readers/task-draft.js";
import { DEFAULT_REDACTION_RULES, RegexRedactor } from "./redaction/regex.js";
import { RegistrarReader } from "./registrar/reader.js";
import { RegistrarWriter } from "./registrar/writer.js";
import { type AaSnapshotStore, createAaSnapshotStore } from "./routing/aa-snapshot-store.js";
import { DispatchEventLog } from "./services/dispatch-event-log.js";
import { ScratchWorktreesService } from "./services/scratch-worktrees.js";
import { SessionEventLog } from "./services/session-event-log.js";
import { SessionNoteDrafts } from "./services/session-note-drafts.js";
import { type Settings, SettingsDefaults, type SettingsInput } from "./settings.js";
import { InProcessSupervisor } from "./supervisor/in-process.js";
import { TaskWriter } from "./tasks/writer.js";
import { type Clock, systemClock } from "./utils/clock.js";
import { systemUuid, type Uuid } from "./utils/uuid.js";
import { WorktreeManager } from "./worktree/manager.js";
import { HandoffWriter } from "./writers/handoff.js";
import { NotificationOutboxWriter } from "./writers/notification-outbox.js";
import { PermissionWriter } from "./writers/permission.js";
import { T0Writer } from "./writers/t0.js";

export interface WorkflowRunInfo {
  workflow_name: string;
  project_id: string | null;
  registered_at: number;
}

export type WorkflowRunStatus = "running" | "completed" | "failed";

export interface WorkflowRunRecord {
  status: WorkflowRunStatus;
  started_at: number;
  finished_at?: number;
  result?: unknown;
  error?: unknown;
}

export interface WorkflowStatusLight {
  status: WorkflowRunStatus;
  started_at: number;
  finished_at?: number;
  result_available: boolean;
  result_bytes: number;
  error_bytes: number;
}

export interface WorkflowRunsRegistry {
  register(workflowName: string, projectId: string | null): string | null;
  verify(workflowRunId: string): WorkflowRunInfo | null;
  unregister(workflowRunId: string): void;
  recordResult(workflowRunId: string, result: unknown): Promise<void>;
  recordError(workflowRunId: string, error: unknown): Promise<void>;
  getStatus(workflowRunId: string): Promise<WorkflowRunRecord | null>;
  getStatusLight(workflowRunId: string): Promise<WorkflowStatusLight | null>;
  waitForResult(workflowRunId: string, timeoutMs: number): Promise<WorkflowRunRecord | null>;
  setPersistenceStatus(
    workflowRunId: string,
    status: "pending" | "persisted" | "persistence_failed",
  ): void;
  setExecutionRecord(workflowRunId: string, record: WorkflowRunRecord): void;
}

export interface AgentRoutingConfig {
  agents: {
    name: string;
    roles: string[];
    subscription_provider?: string;
    api_provider?: string;
    pricing_mode?: "api" | "subscription";
    // Adapter identifier (e.g. "stdio-acp", "claude-acp", "openai-compat-http").
    // Propagated to the scorer for tool_free-aware ranking.
    adapter?: string;
    // Permission profiles this seat can enforce (e.g. ["review_readonly"]).
    // Read by agentEnforcesPermissionProfile for profile-constrained routing.
    enforces_permission_profiles?: readonly string[];
  }[];
  default_roles: Record<string, string>;
  role_exploration_policy?: "unsampled-first" | "ranked-first";
  role_routing?: {
    headroom_weighting?: boolean;
    latency_weighting?: boolean;
    exploration_policy?: string;
  };
}

export interface Watchdog {
  recordHeartbeat(worker_id: string): void;
  hasActiveWorker(timeoutMs: number): boolean;
  getStaleWorkers(timeoutMs: number): string[];
  getStaleHeartbeatAges(timeoutMs: number): { worker_id: string; last_seen_age_ms: number }[];
  tick(): Promise<void>;
}

export interface ShellSessionPoolLike {
  createSession(input: {
    handoffId: string;
    cwd: string;
    env: Record<string, string>;
    pty: boolean;
    agentName?: string;
  }): Promise<{ sessionId: string }>;
  runCommand(input: {
    handoffId: string;
    sessionId: string;
    command: string;
    stdin?: string;
    agentName?: string;
  }): Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }>;
  closeSession(input: { handoffId: string; sessionId: string }): Promise<{ closed: boolean }>;
  listSessions(handoffId: string): {
    session_id: string;
    created_at: string;
    last_used_at: string;
    cwd: string;
    pty: boolean;
  }[];
  reapHandoff(handoffId: string): Promise<void>;
  reapTerminalHandoffs(): Promise<void>;
  reapIdleSessions(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeShellConfigLike {
  enabled: boolean;
  dangerousCommandsForAgent(agentName: string): string[];
}

export interface LongLivedReactorLike {
  manualTick(agent_id: string): {
    outcome: string;
    tick_id?: string;
    chain_id?: string;
  };
  injectedGoalTick?(agent_id: string): {
    outcome: string;
    tick_id?: string;
    chain_id?: string;
  };
  reload(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface McpPoolLike {
  callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    opts?: { timeoutMs?: number; _meta?: Record<string, unknown> },
  ): Promise<unknown>;
  listTools(
    serverName: string,
  ): Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  getFederationHealth(): {
    registered: { server: string; tool: string; name: string }[];
    skipped: { server: string; tool: string; reason: string }[];
  };
  shutdown(): Promise<void>;
}

export interface ActionGateLike {
  handleCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    _meta?: Record<string, unknown>;
    pending_action_id?: string;
  }): Promise<
    | { kind: "executed"; result: unknown; tier: 1 | 2 | 3; snapshot_id?: string }
    | { kind: "rejected"; error: string; details?: unknown }
    | { kind: "queued"; pending_action_id: string }
  >;
}

export interface NotificationEventsBusLike {
  emit(event: unknown): void;
}

export interface WorkerManagerLike {
  lookupSession(chain_handoff_id: string): unknown;
}

export interface WorkflowDirsLike {
  playbooksDir: string;
  workflowsDir: string;
}

export interface LocalSeatHealthLike {
  getUnhealthyAgents(): ReadonlySet<string>;
}

export interface Services {
  settings: Settings;
  storageRoot: string;
  reviewsDir: string;
  db: Database;
  dbMeta: DbMeta;
  machineId: MachineId;
  projectCache: ProjectCache;
  redactor: RegexRedactor;
  t0Writer: T0Writer;
  handoffWriter: HandoffWriter;
  recallReader: RecallReader;
  handoffReader: HandoffReader;
  taskDraftReader: TaskDraftReader;
  chainReader: ChainReader;
  handoffEvents: HandoffEventBus;
  handoffTransitions: HandoffTransitionBus;
  permissionWriter: PermissionWriter;
  permissionReader: PermissionReader;
  permissionEvents: PermissionEventBus;
  dispatchEventLog: DispatchEventLog;
  sessionEventLog: SessionEventLog;
  sessionNoteDrafts: SessionNoteDrafts;
  dispatchEvents: DispatchEventBus;
  projectRegistry?: ProjectRegistry;
  shellSessionPool?: ShellSessionPoolLike;
  shellConfig?: RuntimeShellConfigLike;
  conversationStream: ConversationStreamBus;
  workerControl: WorkerControlBus;
  worktreeManager: WorktreeManager;
  scratchWorktrees: ScratchWorktreesService;
  watchdog: Watchdog;
  orphanHandoffRecovery?: {
    runOnce(workerId?: string): {
      requeued: number;
      exhausted: number;
      exhaustedRowIds: string[];
      requeuedRowIds: string[];
      _exhaustedRows: HandoffRow[];
      _requeuedRows: HandoffRow[];
    };
  };
  supervisor: WorkerSupervisor;
  pidRegistry: PidRegistry;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  log: Logger;
  agentRegistry: string[] | null;
  agentRouting: AgentRoutingConfig | null;
  // Model task router config (router.yaml / model-aliases.yaml). Absent in
  // most tests and in the bare buildServices() path; role-routing.ts treats
  // an absent taskRouterConfig identically to an explicit mode:'off'.
  taskRouterConfig?: TaskRouterConfig;
  modelAliasMap?: ModelAliasMap;
  aaSnapshotStore: AaSnapshotStore;
  agentchatConfig?: {
    agents?: {
      name: string;
      roles: string[];
      adapter?: string;
      options?: Record<string, unknown>;
      subscription_provider?: string;
      subscription_model?: string;
      api_provider?: string;
      pricing_mode?: "api" | "subscription";
      enforces_permission_profiles?: readonly string[];
    }[];
  };
  providerQuotas: ProviderQuota[];
  subscriptionPressureCache: SubscriptionPressureCache;
  workflowRuns?: WorkflowRunsRegistry;
  memoryEfficacyRunnerHeartbeatAt?: number;
  notificationEvents?: NotificationEventsBusLike;
  notificationOutbox: NotificationOutboxWriter;
  workflowRegistry?: WorkflowRegistry;
  taskCooldowns?: TaskCooldowns;
  maestroSessions?: MaestroSessionWriter;
  taskWriter?: TaskWriter;
  workerManager?: WorkerManagerLike;
  workflowDirs?: WorkflowDirsLike;
  localSeatHealth?: LocalSeatHealthLike;
  longLivedReactor?: LongLivedReactorLike;
  mcpPool?: McpPoolLike;
  actionGate?: ActionGateLike;
  planWriter: PlanWriter;
  registrarWriter: RegistrarWriter;
  registrarReader: RegistrarReader;
}

export interface BuildServicesOpts {
  env: NodeJS.ProcessEnv;
  input: SettingsInput;
  storageRoot: string;
  reviewsDir?: string;
  db: Database;
  embedder: Embedder;
  clock?: Clock;
  uuid?: Uuid;
  softPidCap?: number;
  hardPidCap?: number;
  agentRegistry?: string[] | null;
  agentRouting?: AgentRoutingConfig | null;
  providerQuotas?: ProviderQuota[];
  worktreeRootDir?: string;
  mainRepoDir?: string;
  workflowRegistry?: WorkflowRegistry;
  projectRegistry?: ProjectRegistry;
  workflowRuns?: WorkflowRunsRegistry;
}

// chain_start falls back to the manager's mapping when the registry cannot be
// read (daemon routes/chains.ts), so an unreadable live registry must not
// break that fallback.
function liveProjectRoot(
  liveRegistry: () => ProjectRegistry | undefined,
  bootRegistry: ProjectRegistry | undefined,
  log: Logger,
  id: string,
): string | undefined {
  try {
    return liveRegistry()?.get(id)?.root_path;
  } catch (err) {
    log.warn(
      { project_id: id, err: err instanceof Error ? err.message : String(err) },
      "live project registry unreadable; resolving through the boot registry",
    );
    return bootRegistry?.get(id)?.root_path;
  }
}

function liveRegistrySize(
  liveRegistry: () => ProjectRegistry | undefined,
  bootRegistry: ProjectRegistry | undefined,
): number {
  try {
    return liveRegistry()?.size ?? 0;
  } catch {
    return bootRegistry?.size ?? 0;
  }
}

function createServicesWorktreeManager(
  opts: BuildServicesOpts,
  log: Logger,
  liveRegistry: () => ProjectRegistry | undefined,
): WorktreeManager {
  return new WorktreeManager({
    rootDir: opts.worktreeRootDir,
    mainRepoDir: opts.mainRepoDir,
    log,
    resolveProjectRoot: (id: string): string | undefined =>
      liveProjectRoot(liveRegistry, opts.projectRegistry, log, id),
    requireKnownProjectId: (): boolean => liveRegistrySize(liveRegistry, opts.projectRegistry) > 0,
    resolveBranchName: (handoff_id: string): string | null | undefined =>
      opts.db
        .query<
          { branch_name: string | null },
          [string]
        >(`SELECT branch_name FROM handoffs WHERE handoff_id = ?`)
        .get(handoff_id)?.branch_name,
    onBranchNameDrift: (handoff_id, actualBranchName, storedBranchName): void => {
      opts.db
        .query<
          unknown,
          [string, string]
        >(`UPDATE handoffs SET branch_name = ? WHERE handoff_id = ?`)
        .run(actualBranchName, handoff_id);
      log.warn(
        { handoff_id, actual_branch_name: actualBranchName, stored_branch_name: storedBranchName },
        "worktree branch_name drift repaired",
      );
    },
  });
}

export function buildServices(opts: BuildServicesOpts): Services {
  const settings = SettingsDefaults.build({ env: opts.env, input: opts.input });
  const clock = opts.clock ?? systemClock;
  const uuid = opts.uuid ?? systemUuid;
  const log = createLogger({ component: "penumbra" });
  const machineId = new MachineId({ storageRoot: opts.storageRoot, uuid });
  const handoffEvents = new HandoffEventBus();
  const handoffTransitions = new HandoffTransitionBus();
  const permissionEvents = new PermissionEventBus();
  const conversationStream = new ConversationStreamBus();
  const workerControl = new WorkerControlBus();
  const dispatchEvents = new DispatchEventBus();
  // eslint-disable-next-line prefer-const -- closure reads before assignment; daemon reload mutates the returned object's projectRegistry in-place
  let services: Services | undefined;
  const worktreeManager = createServicesWorktreeManager(
    opts,
    log,
    () => services?.projectRegistry ?? opts.projectRegistry,
  );
  const watchdog: Watchdog = {
    recordHeartbeat: () => undefined,
    hasActiveWorker: () => false,
    getStaleWorkers: () => [],
    getStaleHeartbeatAges: () => [],
    tick: () => Promise.resolve(),
  };
  const dispatchEventLog = new DispatchEventLog(opts.db, dispatchEvents);
  const scratchWorktrees = new ScratchWorktreesService({
    db: opts.db,
    worktreeManager,
    projectRegistry: opts.projectRegistry,
    dispatchEventLog,
    log,
    mainRepoDir: opts.mainRepoDir,
    storageRoot: opts.storageRoot,
  });
  services = {
    settings,
    storageRoot: opts.storageRoot,
    reviewsDir: opts.reviewsDir ?? pathResolve(opts.storageRoot, "..", ".penumbra/reviews"),
    db: opts.db,
    dbMeta: new DbMeta(opts.db),
    machineId,
    projectCache: new ProjectCache({ db: opts.db, clock }),
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
    t0Writer: new T0Writer(opts.db),
    handoffWriter: new HandoffWriter({
      db: opts.db,
      events: handoffEvents,
      transitions: handoffTransitions,
    }),
    recallReader: new RecallReader({ db: opts.db, embedder: opts.embedder }),
    handoffReader: new HandoffReader({ db: opts.db }),
    taskDraftReader: new TaskDraftReader({ db: opts.db }),
    chainReader: new ChainReader(opts.db),
    handoffEvents,
    handoffTransitions,
    permissionWriter: new PermissionWriter({ db: opts.db }),
    permissionReader: new PermissionReader({ db: opts.db }),
    permissionEvents,
    dispatchEventLog,
    sessionEventLog: new SessionEventLog(opts.db),
    sessionNoteDrafts: new SessionNoteDrafts(opts.db),
    dispatchEvents,
    projectRegistry: opts.projectRegistry,
    conversationStream,
    workerControl,
    worktreeManager,
    scratchWorktrees,
    watchdog,
    supervisor: new InProcessSupervisor({ log }),
    pidRegistry: new PidRegistry({
      softCap: opts.softPidCap ?? 8,
      hardCap: opts.hardPidCap ?? 16,
    }),
    embedder: opts.embedder,
    clock,
    uuid,
    log,
    agentRegistry: opts.agentRegistry ?? null,
    agentRouting: opts.agentRouting ?? null,
    // Default placeholder for tests and bare services; daemon serve() replaces
    // it at boot with a store using the active router snapshot TTL.
    aaSnapshotStore: createAaSnapshotStore({ now: clock }),
    providerQuotas: opts.providerQuotas ?? [],
    subscriptionPressureCache: createSubscriptionPressureCache(opts.db, {
      intervalMs: 30_000,
      log,
    }),
    workflowRegistry: opts.workflowRegistry,
    workflowRuns: opts.workflowRuns,
    planWriter: new PlanWriter(opts.db, () => clock().getTime()),
    registrarWriter: new RegistrarWriter(opts.db, () => clock().getTime()),
    registrarReader: new RegistrarReader(opts.db),
    notificationOutbox: new NotificationOutboxWriter(opts.db),
  };
  return services;
}
