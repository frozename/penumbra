import {
  getLane,
  MemoryVerifyAuthorizeInputShape,
  type Services,
  validateBasis,
  verifyMemory,
} from "@penumbra/core";
import { z } from "zod";

import { json } from "./_helpers.js";

const RequestSchema = z.object(MemoryVerifyAuthorizeInputShape);

function validationError(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return json(
    {
      error: {
        code: "validation_error",
        message: "body failed schema validation",
        field_errors: issues,
      },
    },
    400,
  );
}

function shortSummary(basis: z.infer<typeof RequestSchema.shape.basis>): string {
  switch (basis.kind) {
    case "lane_close":
      return `lane ${basis.lane_id}`;
    case "dispatch_land":
      return `dispatch ${basis.reviewer_handoff}`;
    case "adversarial_review":
      return `adversarial ${basis.synthesizer_handoff}`;
    case "manual_override":
      return basis.reason;
  }
}

function dispatchLandRecalledMemoryIds(services: Services, handoffId: string): string[] {
  const row = services.db
    .query<{ recalled_memory_ids: string | null }, [string]>(
      `SELECT recalled_memory_ids FROM lane_ledger
       WHERE implementer_handoff = ? AND ts_closed IS NOT NULL
       ORDER BY ts_closed DESC LIMIT 1`,
    )
    .get(handoffId);
  if (!row?.recalled_memory_ids) return [];
  try {
    const parsed = JSON.parse(row.recalled_memory_ids) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    for (const id of parsed) {
      if (typeof id === "string" && id.trim().length > 0) ids.add(id);
    }
    return [...ids];
  } catch {
    return [];
  }
}

export async function memoryVerifyAuthorizeRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error.issues);
  const basisValidation = await validateBasis(services, parsed.data.basis);
  if (!basisValidation.ok) {
    return json(
      { error: { code: basisValidation.status, reason: basisValidation.reason } },
      basisValidation.status,
    );
  }
  const verifierActor = services.machineId.get();
  const basis = parsed.data.basis;
  if (basis.kind !== "lane_close" && basis.kind !== "dispatch_land") {
    return json({
      ok: true,
      authorized: true,
      events_written: 0,
      reason: `basis ${basis.kind} has no lane_ledger recalled_memory_ids source; only lane_close can authorize recalled memories`,
    });
  }

  let missingLaneId: string | null = null;
  let memoryIds: string[] | null;
  if (basis.kind === "lane_close") {
    const laneId = basis.lane_id;
    const lane = getLane(services.db, laneId);
    if (!lane) {
      missingLaneId = laneId;
    }
    memoryIds = lane?.recalled_memory_ids ?? null;
  } else {
    memoryIds = dispatchLandRecalledMemoryIds(services, parsed.data.handoff_id);
  }
  if (memoryIds === null) {
    return json({
      ok: true,
      authorized: true,
      events_written: 0,
      reason: `lane ${missingLaneId ?? "unknown"} not found while resolving recalled memories`,
    });
  }
  let written = 0;
  for (const memoryId of memoryIds) {
    const result = verifyMemory(services.db, memoryId, {
      verifierActor,
      reason: shortSummary(basis),
      sessionId: parsed.data.handoff_id,
      basis: { type: basis.kind, detail: shortSummary(basis), basis: JSON.stringify(basis) },
      authorizedByHandoff: parsed.data.authorized_by_handoff ?? null,
      uuid: services.uuid,
    });
    if (result?.written) written += 1;
  }
  return json({ ok: true, authorized: true, events_written: written });
}
