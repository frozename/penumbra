import type { DaemonServices } from "../serve.js";

import { json } from "./_helpers.js";
import {
  commitAgentChatConfigSubsystem,
  commitWorkflowAndProjectRegistrySubsystem,
  reloadAgentChatConfigSubsystem,
  reloadExtraWorkersSubsystem,
  reloadLongLivedReactorSubsystem,
  type ReloadSubsystemStatus,
  reloadWorkflowAndProjectRegistrySubsystem,
} from "./reload-config-orchestrators.js";

// Serializes overlapping /agentchat/reload calls per DaemonServices instance
// so a slower workflow-registry rebuild can't commit its stale snapshot after
// a fresher call has already committed. Queued calls run in invocation order,
// mirroring supervisor.runLifecycleSerial. Keyed per-services so distinct
// daemons in the same process don't share a gate.
const reloadGates = new WeakMap<DaemonServices, Promise<void>>();

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
 *
 * Overlapping calls are serialized per-services via `reloadGates` so that the
 * freshest triggering call's config wins regardless of which disk I/O
 * resolves first.
 */
export function reloadConfigRoute(req: Request, services: DaemonServices): Promise<Response> {
  const prev = reloadGates.get(services) ?? Promise.resolve();
  const run = prev.then(() => reloadConfigRouteUnlocked(req, services));
  reloadGates.set(
    services,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function reloadConfigRouteUnlocked(
  _req: Request,
  services: DaemonServices,
): Promise<Response> {
  const agentchatSubsystem = reloadAgentChatConfigSubsystem(services);
  if (agentchatSubsystem.status === "failed") {
    const status = 422;
    return json({ error: agentchatSubsystem.error }, status);
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

  commitAgentChatConfigSubsystem(services, agentchatSubsystem.snapshot);
  commitWorkflowAndProjectRegistrySubsystem(services, workflowProjectSubsystem.snapshot);
  services.workerControl.emit({ type: "agentchat_reload" });

  const reactorSubsystem = await reloadLongLivedReactorSubsystem(services);
  const workersSubsystem = await reloadExtraWorkersSubsystem(
    services,
    workflowProjectSubsystem.meta.project_registry,
  );
  const workerExtras =
    workersSubsystem.status === "failed"
      ? { error: workersSubsystem.error }
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
    reloaded_at: services.clock().toISOString(),
  });
}
