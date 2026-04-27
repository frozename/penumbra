import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { Services } from '@penumbra/core';
// @ts-ignore
import { loadConfig } from '@penumbra/agentchat/src/config/load.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function reloadConfigRoute(_req: Request, services: Services): Response {
  const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
  if (!existsSync(configPath)) {
    return json({ error: `Config file not found at ${configPath}` }, 422);
  }

  try {
    const config = loadConfig(configPath);
    services.agentRegistry = config.agents.map((a: any) => a.name);
    return json({
      ok: true,
      agent_count: services.agentRegistry?.length ?? 0,
      reloaded_at: typeof services.clock === 'function' ? (services.clock() as any).toISOString() : new Date().toISOString()
    });
  } catch (err: any) {
    return json({ error: err.message }, 422);
  }
}
