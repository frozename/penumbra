import { buildDispatchAuditReport, type DispatchAuditSources } from "@penumbra/core";

import { json } from "./_helpers.js";

export function dispatchAuditRoute(req: Request, services: DispatchAuditSources): Response {
  const url = new URL(req.url);
  const handoffId = url.searchParams.get("handoff_id");
  if (!handoffId) return json({ error: "missing_handoff_id" }, 400);

  const report = buildDispatchAuditReport(services, handoffId);
  if (!report) return json({ error: "handoff_not_found" }, 404);

  return json({ report });
}
