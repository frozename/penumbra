import { getLane, type Services, validateBasis, verifyMemory } from "@penumbra/core";
import { z } from "zod";

import { json } from "./_helpers.js";

const BasisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lane_close"),
    lane_id: z.string().min(1),
    reviewer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("dispatch_land"),
    merge_commit: z
      .string()
      .min(7)
      .max(40)
      .regex(/^[a-f0-9]+$/),
    reviewer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("adversarial_review"),
    synthesis_path: z.string().min(1),
    synthesizer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("manual_override"),
    reason: z.string().min(1),
    authorized_by: z.string().min(1),
  }),
]);

const RequestSchema = z.object({
  handoff_id: z.string().min(1),
  verdict: z.enum(["passed", "failed", "skipped", "review_debt"]),
  basis: BasisSchema,
  authorized_by_handoff: z.string().min(1).optional().nullable(),
});

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

function shortSummary(basis: z.infer<typeof BasisSchema>): string {
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

function extractMetaMemoryIds(metaJson: string): string[] {
  try {
    const meta = JSON.parse(metaJson) as Record<string, unknown>;
    const ids: string[] = [];
    const one = meta.memory_id;
    if (typeof one === "string" && one.trim().length > 0) ids.push(one);
    const many = meta.memory_ids;
    if (Array.isArray(many)) {
      for (const id of many) {
        if (typeof id === "string" && id.trim().length > 0) ids.push(id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function dispatchLandRecalledMemoryIds(services: Services, handoffId: string): string[] {
  const rows = services.db
    .query<{ meta_json: string | null }, [string]>(
      `SELECT meta_json FROM dispatch_events
       WHERE handoff_id = ? AND kind = 'memory_recall_injected'
       ORDER BY ts ASC, id ASC`,
    )
    .all(handoffId);
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.meta_json) continue;
    for (const id of extractMetaMemoryIds(row.meta_json)) {
      ids.add(id);
    }
  }
  return [...ids];
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
