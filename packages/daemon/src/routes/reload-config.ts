import {
  reloadAgentChatConfigSubsystem,
  reloadExtraWorkersSubsystem,
  reloadLongLivedReactorSubsystem,
  reloadWorkflowAndProjectRegistrySubsystem,
  type ReloadSubsystemStatus,
} from "./reload-config-orchestrators.js";
import type { DaemonServices } from "../serve.js";

import { json } from "./_helpers.js";

/**
 * POST /agentchat/reload
 * Reloads the daemon-side validation registry, agentchat config snapshot,
 * derived shell config, and the workflow registry. The shell route reads
 * `services.agentchatConfig` and `services.shellConfig` per request, so
 * refreshing those refs is enough for agent-level changes (e.g.
 * `auto_approve_to`, dangerous-command patterns) to take effect without a
 * full daemon restart. The shellSessionPool is constructed once at startup;
 * pool-level limits (max sessions, idle timeout) still require a restart.
 *
 * The workflow registry is rebuilt from the same playbooks/workflows dirs
 * the daemon was launched against. If the rebuild fails the previous
 * registry is left in place so in-flight runs and triggers don't break.
 * The long-lived reactor is reconciled here too; reload failures are
 * surfaced as reactor_status: 'failed' without failing the overall route.
 *
 * Worker agentchat config is automatically reloaded via the worker control bus
 * on a successful config reload here.
 */
export async function reloadConfigRoute(
  _req: Request,
  services: DaemonServices,
): Promise<Response> {
  const agentchatSubsystem = await reloadAgentChatConfigSubsystem(services);
  if (agentchatSubsystem.status === "failed") {
    const status =
      agentchatSubsystem.meta.reason === "missing_config" ||
      agentchatSubsystem.meta.reason === "invalid_config"
        ? 422
        : 500;
    return json({ error: agentchatSubsystem.error }, status);
  }

  if (agentchatSubsystem.status === "reloaded") {
    services.workerControl?.emit({ type: "agentchat_reload" });
  }

  const workflowProjectSubsystem = await reloadWorkflowAndProjectRegistrySubsystem(services);
  if (workflowProjectSubsystem.status === "failed") {
    services.log.error(
      {
        err: workflowProjectSubsystem.error,
        playbooksDir: workflowProjectSubsystem.meta.playbooks_dir,
        workflowsDir: workflowProjectSubsystem.meta.workflows_dir,
        projectRegistryPath: workflowProjectSubsystem.meta.project_registry_path,
      },
      "workflow-registry-rebuild-failed",
    );
    return json(
      { error: `workflow registry rebuild failed: ${workflowProjectSubsystem.error}` },
      500,
    );
  }

  const reactorSubsystem = await reloadLongLivedReactorSubsystem(services);
  const workersSubsystem = await reloadExtraWorkersSubsystem(
    services,
    workflowProjectSubsystem.meta.project_registry,
  );
  const workerExtras =
    workersSubsystem.status === "failed"
      ? { error: workersSubsystem.error ?? "failed to reload extra workers" }
      : workersSubsystem.status === "reloaded"
        ? workersSubsystem.meta.summary
        : {
            started: [],
            restarted: [],
            stopped: [],
            skipped: [],
            errors: [],
          };

  const agentCount = services.agentRegistry?.length ?? 0;
  const workflowCount = services.workflowRegistry?.list().length ?? 0;
  const projectRegistryCount = services.projectRegistry?.list().length ?? 0;
  const reactorStatus: ReloadSubsystemStatus = reactorSubsystem.status;
  const reactorError = reactorSubsystem.error;

  services.log.info(
    {
      agent_count: agentCount,
      prev_count: agentchatSubsystem.meta.prev_count,
      workflow_count: workflowCount,
      project_registry_count: projectRegistryCount,
      reactor_status: reactorStatus,
      ...(reactorError ? { reactor_error: reactorError } : {}),
    },
    "agentchat-config-reloaded",
  );

  return json({
    ok: true,
    agent_count: agentCount,
    workflow_count: workflowCount,
    project_registry_count: projectRegistryCount,
    reactor_status: reactorStatus,
    worker_extras: workerExtras,
    ...(reactorError ? { reactor_error: reactorError } : {}),
    reloaded_at:
      typeof services.clock === "function"
        ? (services.clock() as any).toISOString()
        : new Date().toISOString(),
  });
}
