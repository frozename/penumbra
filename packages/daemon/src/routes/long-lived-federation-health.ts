import type { Services } from "@penumbra/core";

import { json } from "./_helpers.js";
export function longLivedFederationHealthRoute(_req: Request, services: Services): Response {
  if (!services.mcpPool) {
    return json({ registered: [], skipped: [] });
  }
  return json(services.mcpPool.getFederationHealth());
}
