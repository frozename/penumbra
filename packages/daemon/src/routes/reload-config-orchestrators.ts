import { loadShellConfig } from "@penumbra/agentchat/worker/shell-config";
import {
  getConfig,
  loadModelAliasMapFromDir,
  loadTaskRouterConfigFromDir,
  reloadAgentChatConfig,
} from "@penumbra/config";
import {
  createAaSnapshotStore,
  defaultProjectRegistryPath,
  loadProjectRegistry,
  type ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { buildRegistry as buildWorkflowRegistry } from "@penumbra/workflows";
import { join } from "node:path";

import type { DaemonServices } from "../serve.js";
import type { ReconcileSummary } from "../workers/supervisor.js";

// Deep-relative: node_modules/@penumbra/config in this worktree symlinks to the
// pre-change checkout, so the package specifier would not resolve this new export.
// Resolves to the same file as @penumbra/config post-land.
import { collectMissingRoutingAgents } from "../../../config/src/generator/routing-refs.js";
import {
  formatAgentChatConfigError,
  loadAgentChatConfigUncached,
  loadAgentRoutingFromConfig,
  resolveAgentChatConfigPath,
} from "../agentchat-config.js";
import { buildDreamingConfig } from "../dreaming/config.js";
import {
  buildRequiredLlmRoleFloors,
  evaluateLlmRoleFloors,
  logLlmRoleFloorViolations,
} from "../services/subsystem-health.js";
import { type ExtraWorkersConfig, loadExtraWorkersConfig } from "../workers/config.js";

export type ReloadSubsystemName =
  | "agentchat_config"
  | "task_router_config"
  | "workflow_and_project_registry"
  | "long_lived_reactor"
  | "extra_workers";

export type ReloadSubsystemStatus = "reloaded" | "failed" | "absent";

type AgentChatConfigFailure = {
  subsystem: "agentchat_config";
  status: "failed";
  error: string;
  meta: {
    reason: "missing_config" | "invalid_config";
    config_path: string;
  };
};

type AgentChatConfigReloaded = {
  subsystem: "agentchat_config";
  status: "reloaded";
  error?: never;
  snapshot: AgentChatConfigSnapshot;
  meta: {
    config_path: string;
    prev_count: number;
    agent_count: number;
  };
};

type TaskRouterConfigFailed = {
  subsystem: "task_router_config";
  status: "failed";
  error: string;
  meta: { config_path: string };
};

type TaskRouterConfigReloaded = {
  subsystem: "task_router_config";
  status: "reloaded";
  error?: never;
  snapshot: TaskRouterConfigSnapshot;
  meta: { config_path: string };
};

type WorkflowAndProjectRegistryReloaded = {
  subsystem: "workflow_and_project_registry";
  status: "reloaded";
  error?: never;
  snapshot: WorkflowProjectSnapshot;
  meta: {
    workflow_count: number;
    project_registry_count: number;
    project_registry: ProjectRegistry;
    playbooks_dir: string;
    workflows_dir: string;
    project_registry_path: string;
  };
};

type WorkflowAndProjectRegistryFailed = {
  subsystem: "workflow_and_project_registry";
  status: "failed";
  error: string;
  meta: {
    playbooks_dir: string;
    workflows_dir: string;
    project_registry_path: string;
  };
};

type LongLivedReactorReloaded = {
  subsystem: "long_lived_reactor";
  status: "reloaded";
  error?: never;
  meta?: never;
};

type LongLivedReactorAbsent = {
  subsystem: "long_lived_reactor";
  status: "absent";
  error?: never;
  meta?: never;
};

type LongLivedReactorFailed = {
  subsystem: "long_lived_reactor";
  status: "failed";
  error: string;
  meta?: never;
};

type ExtraWorkersReloaded = {
  subsystem: "extra_workers";
  status: "reloaded";
  error?: never;
  meta: {
    config: ExtraWorkersConfig;
    summary: ReconcileSummary;
  };
};

type ExtraWorkersFailed = {
  subsystem: "extra_workers";
  status: "failed";
  error: string;
  meta?: {
    config?: ExtraWorkersConfig;
  };
};

type ExtraWorkersAbsent = {
  subsystem: "extra_workers";
  status: "absent";
  error?: never;
  meta: {
    config: ExtraWorkersConfig;
  };
};

export type ReloadSubsystemEntry =
  | AgentChatConfigFailure
  | AgentChatConfigReloaded
  | TaskRouterConfigFailed
  | TaskRouterConfigReloaded
  | WorkflowAndProjectRegistryReloaded
  | WorkflowAndProjectRegistryFailed
  | LongLivedReactorReloaded
  | LongLivedReactorAbsent
  | LongLivedReactorFailed
  | ExtraWorkersReloaded
  | ExtraWorkersFailed
  | ExtraWorkersAbsent;

export type AgentChatConfigReloadResult = AgentChatConfigFailure | AgentChatConfigReloaded;
export type TaskRouterConfigReloadResult = TaskRouterConfigFailed | TaskRouterConfigReloaded;
export type WorkflowProjectReloadResult =
  | WorkflowAndProjectRegistryReloaded
  | WorkflowAndProjectRegistryFailed;
export type LongLivedReactorReloadResult =
  | LongLivedReactorReloaded
  | LongLivedReactorFailed
  | LongLivedReactorAbsent;
export type ExtraWorkersReloadResult =
  | ExtraWorkersReloaded
  | ExtraWorkersFailed
  | ExtraWorkersAbsent;

type AgentChatConfigSnapshot = {
  agentRegistry: string[];
  agentRouting: ReturnType<typeof loadAgentRoutingFromConfig>;
  providerQuotas: DaemonServices["providerQuotas"];
  agentchatConfig: DaemonServices["agentchatConfig"];
  shellConfig: NonNullable<DaemonServices["shellConfig"]>;
};

type TaskRouterConfigSnapshot = {
  taskRouterConfig: DaemonServices["taskRouterConfig"];
  modelAliasMap: DaemonServices["modelAliasMap"];
  aaSnapshotStore: DaemonServices["aaSnapshotStore"];
};

type WorkflowProjectSnapshot = {
  workflowRegistry: NonNullable<DaemonServices["workflowRegistry"]>;
  projectRegistry: ProjectRegistry;
};

interface WorkflowDirs {
  playbooksDir: string;
  workflowsDir: string;
}

function resolveWorkflowDirs(services: Services): WorkflowDirs {
  if (services.workflowDirs) return services.workflowDirs;
  const cwd = process.cwd();
  return {
    playbooksDir: join(cwd, "plugin/playbooks"),
    workflowsDir: join(cwd, "plugin/workflows"),
  };
}

export function reloadAgentChatConfigSubsystem(
  services: DaemonServices,
): AgentChatConfigReloadResult {
  const configPath = resolveAgentChatConfigPath(process.env);

  try {
    const prevCount = services.agentRegistry?.length ?? 0;
    const cfg = loadAgentChatConfigUncached(process.env);
    const agentRegistry = cfg.agents.map((agent) => agent.name);
    // `cfg` is AgentChatConfig, which extends both AgentsConfig and RoutingConfig
    // (packages/config/src/files/agentchat-types.ts) — satisfies both params directly.
    const missingAgents = collectMissingRoutingAgents(cfg, cfg);
    if (missingAgents.length > 0) {
      services.log.warn(
        { missing_agents: missingAgents },
        "agentchat-routing-references-missing-agents",
      );
    }
    const snapshot: AgentChatConfigSnapshot = {
      agentRegistry,
      agentRouting: loadAgentRoutingFromConfig(cfg),
      providerQuotas: cfg.providers.map((provider) => ({
        provider: provider.name,
        model: provider.model,
        quota_usd_per_24h: provider.quota_usd_per_24h,
        quota_tokens_per_24h: provider.quota_tokens_per_24h,
        quota_tokens_per_5h: provider.quota_tokens_per_5h,
        pressure_caps: provider.pressure_caps,
      })),
      agentchatConfig: cfg as unknown as DaemonServices["agentchatConfig"],
      shellConfig: loadShellConfig({ agentchat: cfg }),
    };
    return {
      subsystem: "agentchat_config",
      status: "reloaded",
      snapshot,
      meta: {
        config_path: configPath,
        prev_count: prevCount,
        agent_count: snapshot.agentRegistry.length,
      },
    };
  } catch (err: unknown) {
    const formatted = formatAgentChatConfigError(err);
    const reason = /not found/i.test(formatted) ? "missing_config" : "invalid_config";
    return {
      subsystem: "agentchat_config",
      status: "failed",
      error: formatted,
      meta: { reason, config_path: configPath },
    };
  }
}

export function commitAgentChatConfigSubsystem(
  services: DaemonServices,
  snapshot: AgentChatConfigSnapshot,
): void {
  reloadAgentChatConfig();
  services.agentRegistry = snapshot.agentRegistry;
  services.agentRouting = snapshot.agentRouting;
  services.providerQuotas = snapshot.providerQuotas;
  services.agentchatConfig = snapshot.agentchatConfig;
  services.shellConfig = snapshot.shellConfig;
  const dreamConfig = buildDreamingConfig(getConfig());
  services.llmRoleFloorEvaluation = evaluateLlmRoleFloors({
    agentchatConfig: services.agentchatConfig,
    requiredRoles: buildRequiredLlmRoleFloors({
      dreamingAutoPromoteMinJudges: dreamConfig.autoPromoteMinJudges,
    }),
  });
  logLlmRoleFloorViolations({
    log: services.log,
    evaluation: services.llmRoleFloorEvaluation,
  });
}

export function reloadTaskRouterConfigSubsystem(
  services: DaemonServices,
): TaskRouterConfigReloadResult {
  const configPath = resolveAgentChatConfigPath(process.env);
  try {
    const taskRouterConfig = loadTaskRouterConfigFromDir(configPath);
    const snapshot: TaskRouterConfigSnapshot = {
      taskRouterConfig,
      modelAliasMap: loadModelAliasMapFromDir(configPath),
      aaSnapshotStore: createAaSnapshotStore({
        path: services.aaSnapshotPath,
        ttlSeconds: taskRouterConfig.snapshot_ttl_seconds,
        now: () => services.clock(),
      }),
    };
    return {
      subsystem: "task_router_config",
      status: "reloaded",
      snapshot,
      meta: { config_path: configPath },
    };
  } catch (error: unknown) {
    return {
      subsystem: "task_router_config",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      meta: { config_path: configPath },
    };
  }
}

export function commitTaskRouterConfigSubsystem(
  services: DaemonServices,
  snapshot: TaskRouterConfigSnapshot,
): void {
  // Keep this three-field commit synchronous; inserting an await would expose a split router config.
  services.taskRouterConfig = snapshot.taskRouterConfig;
  services.modelAliasMap = snapshot.modelAliasMap;
  services.aaSnapshotStore = snapshot.aaSnapshotStore;
}

export async function reloadWorkflowAndProjectRegistrySubsystem(
  services: DaemonServices,
): Promise<WorkflowProjectReloadResult> {
  const dirs = resolveWorkflowDirs(services);
  const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
  try {
    const workflowRegistry = await buildWorkflowRegistry(dirs);
    const projectRegistry = loadProjectRegistry(projectRegistryPath);
    const snapshot: WorkflowProjectSnapshot = { workflowRegistry, projectRegistry };
    return {
      subsystem: "workflow_and_project_registry",
      status: "reloaded",
      snapshot,
      meta: {
        workflow_count: workflowRegistry.list().length,
        project_registry_count: projectRegistry.list().length,
        project_registry: projectRegistry,
        playbooks_dir: dirs.playbooksDir,
        workflows_dir: dirs.workflowsDir,
        project_registry_path: projectRegistryPath,
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      subsystem: "workflow_and_project_registry",
      status: "failed",
      error,
      meta: {
        playbooks_dir: dirs.playbooksDir,
        workflows_dir: dirs.workflowsDir,
        project_registry_path: projectRegistryPath,
      },
    };
  }
}

export function commitWorkflowAndProjectRegistrySubsystem(
  services: DaemonServices,
  snapshot: WorkflowProjectSnapshot,
): void {
  services.workflowRegistry = snapshot.workflowRegistry;
  services.projectRegistry = snapshot.projectRegistry;
}

export async function reloadLongLivedReactorSubsystem(
  services: DaemonServices,
): Promise<LongLivedReactorReloadResult> {
  if (!services.longLivedReactor) {
    return { subsystem: "long_lived_reactor", status: "absent" };
  }
  try {
    await services.longLivedReactor.reload();
    return { subsystem: "long_lived_reactor", status: "reloaded" };
  } catch (error: unknown) {
    const reactorError = error instanceof Error ? error.message : String(error);
    services.log.warn({ error: reactorError }, "long-lived-reactor-reload-failed");
    return { subsystem: "long_lived_reactor", status: "failed", error: reactorError };
  }
}

export async function reloadExtraWorkersSubsystem(
  services: DaemonServices,
  projectRegistry: ProjectRegistry,
): Promise<ExtraWorkersReloadResult> {
  let config: ExtraWorkersConfig;
  try {
    config = loadExtraWorkersConfig({
      projectRegistry,
      log: services.log,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    services.log.error(
      {
        error: err,
      },
      "extra-worker-reload-failed",
    );
    return {
      subsystem: "extra_workers",
      status: "failed",
      error: err,
    };
  }

  if (!services.extraWorkerSupervisor) {
    return {
      subsystem: "extra_workers",
      status: "absent",
      meta: { config },
    };
  }

  try {
    const summary = await services.extraWorkerSupervisor.reconcile(config.extras);
    return {
      subsystem: "extra_workers",
      status: "reloaded",
      meta: { config, summary },
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    services.log.error(
      {
        error: err,
      },
      "extra-worker-reload-failed",
    );
    return {
      subsystem: "extra_workers",
      status: "failed",
      error: err,
      meta: { config },
    };
  }
}
