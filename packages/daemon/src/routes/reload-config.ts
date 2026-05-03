import { existsSync } from 'node:fs';
import type { Services } from '@penumbra/core';
import { loadShellConfig } from '@penumbra/agentchat/src/worker/shell-config.js';
import { formatAgentChatConfigError, loadAgentChatConfig, resolveAgentChatConfigPath } from '../agentchat-config.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * POST /agentchat/reload
 * Reloads the daemon-side validation registry, agentchat config snapshot, and
 * derived shell config. The shell route reads `services.agentchatConfig` and
 * `services.shellConfig` per request, so refreshing those refs is enough for
 * agent-level changes (e.g. `auto_approve_to`, dangerous-command patterns) to
 * take effect without a full daemon restart. The shellSessionPool is
 * constructed once at startup; pool-level limits (max sessions, idle timeout)
 * still require a restart.
 *
 * Worker agentchat config is reloaded separately via the worker control bus —
 * see daemon.reload_workers.
 */
export function reloadConfigRoute(_req: Request, services: Services): Response {
  const configPath = resolveAgentChatConfigPath(process.env);
  if (!existsSync(configPath)) {
    return json({ error: `Config file not found at ${configPath}` }, 422);
  }

  try {
    const prevCount = services.agentRegistry?.length ?? 0;
    const cfg = loadAgentChatConfig(configPath);
    services.agentRegistry = cfg.agents.map((agent) => agent.name);
    services.agentRouting = {
      agents: cfg.agents.map((agent) => ({ name: agent.name, roles: agent.roles })),
      default_roles: cfg.default_roles,
      role_exploration_policy: cfg.role_routing?.exploration_policy ?? 'unsampled-first',
    };
    const runtime = services as typeof services & {
      agentchatConfig?: typeof cfg;
      shellConfig?: ReturnType<typeof loadShellConfig>;
    };
    runtime.agentchatConfig = cfg;
    runtime.shellConfig = loadShellConfig({ agentchat: cfg });
    const agentCount = services.agentRegistry.length;
    services.log.info({ agent_count: agentCount, prev_count: prevCount }, 'agentchat-config-reloaded');
    return json({
      ok: true,
      agent_count: agentCount,
      reloaded_at: typeof services.clock === 'function' ? (services.clock() as any).toISOString() : new Date().toISOString(),
    });
  } catch (err: any) {
    return json({ error: formatAgentChatConfigError(err) }, 422);
  }
}
