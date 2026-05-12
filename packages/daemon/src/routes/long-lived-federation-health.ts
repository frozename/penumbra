import type { Services } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function longLivedFederationHealthRoute(_req: Request, services: Services): Promise<Response> {
  if (!services.mcpPool) {
    return json({ registered: [], skipped: [] });
  }
  return json(services.mcpPool.getFederationHealth());
}
