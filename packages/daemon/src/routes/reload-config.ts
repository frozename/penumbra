import { existsSync } from 'node:fs';
import type { Services } from '@penumbra/core';
import { formatAgentChatConfigError, loadAgentRegistry, loadAgentRouting, resolveAgentChatConfigPath } from '../agentchat-config.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * POST /agentchat/reload
 * Reloads the daemon-side validation registry. Worker agentchat config is reloaded separately via the worker control bus — see daemon.reload_workers.
 */
export function reloadConfigRoute(_req: Request, services: Services): Response {
  const configPath = resolveAgentChatConfigPath(process.env);
  if (!existsSync(configPath)) {
    return json({ error: `Config file not found at ${configPath}` }, 422);
  }

  try {
    const prevCount = services.agentRegistry?.length ?? 0;
    services.agentRegistry = loadAgentRegistry(configPath);
    services.agentRouting = loadAgentRouting(configPath);
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
