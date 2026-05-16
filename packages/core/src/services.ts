import { Database } from 'bun:sqlite';
import { resolve as pathResolve } from 'node:path';
import { type Settings, type SettingsInput, SettingsDefaults } from './settings.js';
import { MachineId } from './identity/machine-id.js';
import { ProjectCache } from './identity/project-cache.js';
import { DbMeta } from './db/meta.js';
import { DEFAULT_REDACTION_RULES, RegexRedactor } from './redaction/regex.js';
import { T0Writer } from './writers/t0.js';
import { HandoffWriter } from './writers/handoff.js';
import { RecallReader } from './readers/recall.js';
import { HandoffReader } from './readers/handoff.js';
import { TaskDraftReader } from './readers/task-draft.js';
import { ChainReader } from './readers/chain.js';
import { InProcessSupervisor } from './supervisor/in-process.js';
import type { WorkerSupervisor } from './supervisor/interface.js';
import { PidRegistry } from './pid/registry.js';
import { systemClock, type Clock } from './utils/clock.js';
import { systemUuid, type Uuid } from './utils/uuid.js';
import type { Embedder } from './embedder/interface.js';
import { createLogger, type Logger } from './logger.js';
import { HandoffEventBus } from './events/handoff-events.js';
import { ConversationStreamBus } from './events/conversation-stream.js';
import { WorkerControlBus } from './events/worker-control.js';
import { WorktreeManager } from './worktree/manager.js';
import { PermissionWriter } from './writers/permission.js';
import { PermissionReader } from './readers/permission.js';
import { PermissionEventBus } from './events/permission-events.js';
import type { ProviderQuota } from './readers/cost-quota.js';
import { DispatchEventLog } from './services/dispatch-event-log.js';
import { DispatchEventBus } from './dispatch/event-bus.js';
import type { ProjectRegistry } from './projects/registry.js';
import type { WorkflowRegistry } from './workflows/registry-interface.js';
import type { TaskCooldowns } from './tasks/cooldowns.js';
import { MaestroSessionWriter } from './maestro/writer.js';
import { TaskWriter } from './tasks/writer.js';
import { PlanWriter } from './plans/writer.js';
import { createSubscriptionPressureCache, type SubscriptionPressureCache } from './maestro/subscription-pressure-cache.js';

export interface AgentRoutingConfig {
  agents: Array<{ name: string; roles: string[] }>;
  default_roles: Record<string, string>;
  role_exploration_policy?: 'unsampled-first' | 'ranked-first';
}

export interface Watchdog {
  recordHeartbeat(worker_id: string): void;
  hasActiveWorker(timeoutMs: number): boolean;
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
  listSessions(handoffId: string): Array<{
    session_id: string;
    created_at: string;
    last_used_at: string;
    cwd: string;
    pty: boolean;
  }>;
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
  reload(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface McpPoolLike {
  callTool(serverName: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  listTools(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  getFederationHealth(): {
    registered: Array<{ server: string; tool: string; name: string }>;
    skipped: Array<{ server: string; tool: string; reason: string }>;
  };
  shutdown(): Promise<void>;
}

export interface ActionGateLike {
  handleCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    pending_action_id?: string;
  }): Promise<
    | { kind: 'executed'; result: unknown; tier: 1 | 2 | 3; snapshot_id?: string }
    | { kind: 'rejected'; error: string; details?: unknown }
    | { kind: 'queued'; pending_action_id: string }
  >;
}

export interface NotificationEventsBusLike {
  emit(event: unknown): void;
}

export interface WorkerManagerLike {
  lookupSession(chain_handoff_id: string): Promise<unknown> | unknown;
}

export interface WorkflowDirsLike {
  playbooksDir: string;
  workflowsDir: string;
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
  permissionWriter: PermissionWriter;
  permissionReader: PermissionReader;
  permissionEvents: PermissionEventBus;
  dispatchEventLog: DispatchEventLog;
  dispatchEvents: DispatchEventBus;
  projectRegistry?: ProjectRegistry;
  shellSessionPool?: ShellSessionPoolLike;
  shellConfig?: RuntimeShellConfigLike;
  conversationStream: ConversationStreamBus;
  workerControl: WorkerControlBus;
  worktreeManager: WorktreeManager;
  watchdog: Watchdog;
  supervisor: WorkerSupervisor;
  pidRegistry: PidRegistry;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  log: Logger;
  agentRegistry: string[] | null;
  agentRouting: AgentRoutingConfig | null;
  agentchatConfig?: {
    agents?: Array<{
      name: string;
      roles: string[];
      subscription_provider?: string;
      subscription_model?: string;
      api_provider?: string;
      pricing_mode?: 'api' | 'subscription';
    }>;
  };
  providerQuotas: ProviderQuota[];
  subscriptionPressureCache: SubscriptionPressureCache;
  memoryEfficacyRunnerHeartbeatAt?: number;
  notificationEvents?: NotificationEventsBusLike;
  workflowRegistry?: WorkflowRegistry;
  taskCooldowns?: TaskCooldowns;
  maestroSessions?: MaestroSessionWriter;
  taskWriter?: TaskWriter;
  workerManager?: WorkerManagerLike;
  workflowDirs?: WorkflowDirsLike;
  longLivedReactor?: LongLivedReactorLike;
  mcpPool?: McpPoolLike;
  actionGate?: ActionGateLike;
  planWriter: PlanWriter;
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
}

export function buildServices(opts: BuildServicesOpts): Services {
  const settings = SettingsDefaults.build({ env: opts.env, input: opts.input });
  const clock = opts.clock ?? systemClock;
  const uuid = opts.uuid ?? systemUuid;
  const log = createLogger({ component: 'penumbra' });
  const machineId = new MachineId({ storageRoot: opts.storageRoot, uuid });
  const handoffEvents = new HandoffEventBus();
  const permissionEvents = new PermissionEventBus();
  const conversationStream = new ConversationStreamBus();
  const workerControl = new WorkerControlBus();
  const dispatchEvents = new DispatchEventBus();
  const shouldResolveProjectRoot =
    opts.projectRegistry !== undefined &&
    opts.projectRegistry.list().length > 0;
  const worktreeManager = new WorktreeManager({
    rootDir: opts.worktreeRootDir,
    mainRepoDir: opts.mainRepoDir,
    log,
    resolveProjectRoot: shouldResolveProjectRoot
      ? (id: string) => opts.projectRegistry?.get(id)?.root_path
      : undefined,
  });
  const watchdog: Watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => false,
    tick: async () => {},
  };
  return {
    settings,
    storageRoot: opts.storageRoot,
    reviewsDir: opts.reviewsDir ?? pathResolve(opts.storageRoot, '..', '.penumbra/reviews'),
    db: opts.db,
    dbMeta: new DbMeta(opts.db),
    machineId,
    projectCache: new ProjectCache({ db: opts.db, clock }),
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
    t0Writer: new T0Writer(opts.db),
    handoffWriter: new HandoffWriter({ db: opts.db, events: handoffEvents }),
    recallReader: new RecallReader({ db: opts.db, embedder: opts.embedder }),
    handoffReader: new HandoffReader({ db: opts.db }),
    taskDraftReader: new TaskDraftReader({ db: opts.db }),
    chainReader: new ChainReader(opts.db),
    handoffEvents,
    permissionWriter: new PermissionWriter({ db: opts.db }),
    permissionReader: new PermissionReader({ db: opts.db }),
    permissionEvents,
    dispatchEventLog: new DispatchEventLog(opts.db, dispatchEvents),
    dispatchEvents,
    projectRegistry: opts.projectRegistry,
    conversationStream,
    workerControl,
    worktreeManager,
    watchdog,
    supervisor: new InProcessSupervisor(),
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
    providerQuotas: opts.providerQuotas ?? [],
    subscriptionPressureCache: createSubscriptionPressureCache(opts.db, { intervalMs: 30_000, log }),
    workflowRegistry: opts.workflowRegistry,
    planWriter: new PlanWriter(opts.db, () => clock().getTime()),
  };
}
