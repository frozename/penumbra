import { z } from "zod";
import type { Services } from "@penumbra/core";
import { requireWorkerPrincipalMatch } from "../auth.js";
import { json } from "./_helpers.js";
import type { WorkerHealthProbe } from "../services/worker-health-probe.js";

/**
 * POST /worker/probe-ack
 * Acks an active probe emitted on the worker control channel.
 */
export async function workerProbeAckRoute(
  req: Request,
  services: Services & { workerHealthProbe: WorkerHealthProbe },
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  const parsed = z
    .object({ worker_id: z.string().min(1), probe_id: z.string().min(1) })
    .safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
      400,
    );
  }

  const denied = requireWorkerPrincipalMatch(req, parsed.data.worker_id);
  if (denied) return denied;

  const found = services.workerHealthProbe.recordAck(parsed.data.worker_id, parsed.data.probe_id);
  if (!found) {
    return json({ error: { code: "probe_id_unknown" } }, 404);
  }

  return json({});
}
