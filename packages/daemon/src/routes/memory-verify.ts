import { z } from "zod";
import { json } from "./_helpers.js";
import { getLane, type Services, verifyMemory, validateBasis } from "@penumbra/core";

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
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
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
  if (basis.kind !== "lane_close") {
    return json({
      ok: true,
      authorized: true,
      events_written: 0,
      reason: `basis ${basis.kind} has no lane_ledger recalled_memory_ids source; only lane_close can authorize recalled memories`,
    });
  }

  const lane = getLane(services.db, basis.lane_id);
  if (!lane) {
    return json({
      ok: true,
      authorized: true,
      events_written: 0,
      reason: `lane ${basis.lane_id} not found while resolving recalled memories`,
    });
  }

  const memoryIds = lane.recalled_memory_ids;
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
