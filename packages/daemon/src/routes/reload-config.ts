import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadShellConfig } from '../../../agentchat/src/worker/shell-config.ts';
import { buildRegistry as buildWorkflowRegistry } from '@penumbra/workflows';
import { formatAgentChatConfigError, loadAgentChatConfig, resolveAgentChatConfigPath } from '../agentchat-config.js';
import { defaultProjectRegistryPath, loadProjectRegistry } from '../../../core/src/projects/registry.js';
import type { Services } from '../../../core/src/services.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface WorkflowDirs {
  playbooksDir: string;
  workflowsDir: string;
}

function resolveWorkflowDirs(services: Services): WorkflowDirs {
  const runtime = services as Services & { workflowDirs?: WorkflowDirs };
  if (runtime.workflowDirs) return runtime.workflowDirs;
  const cwd = process.cwd();
  return {
    playbooksDir: join(cwd, 'plugin/playbooks'),
    workflowsDir: join(cwd, 'plugin/workflows'),
  };
}

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
 *
 * Worker agentchat config is reloaded separately via the worker control bus —
 * see daemon.reload_workers.
 */
export async function reloadConfigRoute(_req: Request, services: Services): Promise<Response> {
  const configPath = resolveAgentChatConfigPath(process.env);
  if (!existsSync(configPath)) {
    return json({ error: `Config file not found at ${configPath}` }, 422);
  }

  let agentCount: number;
  let prevCount: number;
  try {
    prevCount = services.agentRegistry?.length ?? 0;
    const cfg = loadAgentChatConfig(configPath);
    services.agentRegistry = cfg.agents.map((agent) => agent.name);
    services.agentRouting = {
      agents: cfg.agents.map((agent) => ({ name: agent.name, roles: agent.roles })),
      default_roles: cfg.default_roles,
      role_exploration_policy: cfg.role_routing?.exploration_policy ?? 'unsampled-first',
    };
    services.providerQuotas = cfg.providers.map((provider) => ({
      provider: provider.name,
      model: provider.model,
      quota_usd_per_24h: provider.quota_usd_per_24h,
      quota_tokens_per_24h: provider.quota_tokens_per_24h,
      quota_tokens_per_5h: provider.quota_tokens_per_5h,
      pressure_caps: provider.pressure_caps,
    }));
    const runtime = services as typeof services & {
      agentchatConfig?: typeof cfg;
      shellConfig?: ReturnType<typeof loadShellConfig>;
    };
    runtime.agentchatConfig = cfg;
    runtime.shellConfig = loadShellConfig({ agentchat: cfg });
    agentCount = services.agentRegistry.length;
  } catch (err: any) {
    return json({ error: formatAgentChatConfigError(err) }, 422);
  }

  const dirs = resolveWorkflowDirs(services);
  const projectRegistryPath = process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
  let workflowCount: number;
  try {
    const reg = await buildWorkflowRegistry(dirs);
    services.workflowRegistry = reg;
    workflowCount = reg.list().length;
    services.projectRegistry = loadProjectRegistry(projectRegistryPath);
  } catch (err: any) {
    services.log.error(
      { err: String(err?.message ?? err), playbooksDir: dirs.playbooksDir, workflowsDir: dirs.workflowsDir, projectRegistryPath },
      'workflow-registry-rebuild-failed',
    );
    return json({ error: `workflow registry rebuild failed: ${err?.message ?? err}` }, 500);
  }

  services.log.info(
    { agent_count: agentCount, prev_count: prevCount, workflow_count: workflowCount, project_registry_count: services.projectRegistry?.list().length ?? 0 },
    'agentchat-config-reloaded',
  );
  return json({
    ok: true,
    agent_count: agentCount,
    workflow_count: workflowCount,
    project_registry_count: services.projectRegistry?.list().length ?? 0,
    reloaded_at: typeof services.clock === 'function' ? (services.clock() as any).toISOString() : new Date().toISOString(),
  });
}
