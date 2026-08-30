import { RegistrarCreateRequestSchema, RegistrarEventInputSchema } from "@penumbra/api-contract";
import {
  InvalidEntryTransition,
  InvalidPhaseTransition,
  PhaseNotFound,
  RegistrarNotFound,
  RegistrarSlugTaken,
  type Services,
  UnknownJournalRef,
} from "@penumbra/core";

import { getPrincipal } from "../auth.js";
import { json } from "./_helpers.js";

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function invalidInput(details: unknown): Response {
  return json({ error: "invalid_input", details }, 400);
}

function registrarWriteDenied(req: Request): Response | null {
  // Registrar writes are shared-principal-only in v1; worker auto-append is a future slice.
  const principal = getPrincipal(req);
  if (principal?.kind !== "shared") {
    return json(
      {
        error: {
          code: "principal_forbidden",
          message:
            "registrar writes are restricted to shared-bearer principals; worker-token callers are not authorized",
        },
      },
      403,
    );
  }
  return null;
}

export async function registrarCreateRoute(req: Request, services: Services): Promise<Response> {
  const denied = registrarWriteDenied(req);
  if (denied) return denied;

  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = RegistrarCreateRequestSchema.strict().safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const entry = services.registrarWriter.createEntry(parsed.data);
    return json({ registrar_id: entry.registrar_id }, 201);
  } catch (err) {
    // RegistrarNotFound is unreachable after same-transaction insertion; only slug conflicts map here, and other errors deliberately rethrow to 500.
    if (err instanceof RegistrarSlugTaken) {
      return json({ error: "registrar_slug_taken", slug: err.slug }, 409);
    }
    throw err;
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve registrar append handling while grandfathering its pre-existing complexity.
export async function registrarAppendRoute(
  req: Request,
  registrar_id: string,
  services: Services,
): Promise<Response> {
  const denied = registrarWriteDenied(req);
  if (denied) return denied;

  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = RegistrarEventInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const event = services.registrarWriter.appendEvent(registrar_id, parsed.data);
    return json({ event });
  } catch (err) {
    if (err instanceof RegistrarNotFound) {
      return json({ error: "registrar_not_found", registrar_id }, 404);
    }
    if (err instanceof PhaseNotFound) {
      return json({ error: "phase_not_found", registrar_id, phase_no: err.phase_no }, 404);
    }
    if (err instanceof InvalidPhaseTransition) {
      return json(
        {
          error: "invalid_phase_transition",
          registrar_id,
          phase_no: err.phase_no,
          from_status: err.from_status,
        },
        409,
      );
    }
    if (err instanceof InvalidEntryTransition) {
      return json(
        {
          error: "invalid_entry_transition",
          registrar_id,
          from_status: err.from_status,
          current_status: err.current_status,
        },
        409,
      );
    }
    if (err instanceof UnknownJournalRef) {
      return json(
        { error: "unknown_journal_ref", registrar_id, ref_event_id: err.ref_event_id },
        400,
      );
    }
    throw err;
  }
}

export function registrarListRoute(_req: Request, services: Services): Response {
  return json({ entries: services.registrarReader.listEntries() });
}

export function registrarGetRoute(
  _req: Request,
  registrar_id: string,
  services: Services,
): Response {
  const entry = services.registrarReader.getEntry(registrar_id);
  if (!entry) return json({ error: "registrar_not_found", registrar_id }, 404);

  return json({
    entry,
    phases: services.registrarReader.listPhases(registrar_id),
    events: services.registrarReader.listEvents(registrar_id),
    rollup: services.registrarReader.getRollup(registrar_id),
  });
}

export function registrarListEventsRoute(
  _req: Request,
  registrar_id: string,
  services: Services,
): Response {
  if (!services.registrarReader.getEntry(registrar_id)) {
    return json({ error: "registrar_not_found", registrar_id }, 404);
  }
  return json({ events: services.registrarReader.listEvents(registrar_id) });
}
