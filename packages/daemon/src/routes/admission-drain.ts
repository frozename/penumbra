import type { Services } from "@penumbra/core";

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { json } from "./_helpers.js";

export const ADMISSION_DRAIN_FILE = "admission-drain.json";
export const MAX_ADMISSION_DRAIN_TTL_MS = 1_800_000;
export const DEFAULT_ADMISSION_DRAIN_TTL_MS = 600_000;

export type AdmissionDrainState =
  | {
      draining: true;
      owner: string;
      reason: string | null;
      set_at: string;
      expires_at: string;
      remaining_ms: number;
    }
  | { draining: false; stale?: { owner: string; expires_at: string }; invalid?: true };

type DrainServices = Pick<Services, "storageRoot" | "clock">;
type ContinuationServices = Pick<Services, "storageRoot" | "clock" | "handoffReader">;
type ChainStartDrainServices = ContinuationServices & Pick<Services, "workflowRuns">;

type ActiveAdmissionDrain = Extract<AdmissionDrainState, { draining: true }>;

const DrainFileSchema = z.strictObject({
  owner: z.string().min(1),
  reason: z.string().nullable().optional(),
  set_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
});

function drainFilePath(storageRoot: string | undefined): string | null {
  if (!storageRoot) return null;
  return join(storageRoot, ADMISSION_DRAIN_FILE);
}

export function readAdmissionDrain(
  storageRoot: string | undefined,
  now: Date,
): AdmissionDrainState {
  const path = drainFilePath(storageRoot);
  if (path === null) return { draining: false };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { draining: false };
    return { draining: false, invalid: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { draining: false, invalid: true };
  }

  const validated = DrainFileSchema.safeParse(parsed);
  if (!validated.success) return { draining: false, invalid: true };

  const nowMs = now.getTime();
  const setAtMs = new Date(validated.data.set_at).getTime();
  // A future set_at would otherwise slide the set_at + 30m clamp forward forever.
  if (setAtMs > nowMs) return { draining: false, invalid: true };
  const expiresAtMs = new Date(validated.data.expires_at).getTime();
  const effectiveMs = Math.min(
    expiresAtMs,
    setAtMs + MAX_ADMISSION_DRAIN_TTL_MS,
    nowMs + MAX_ADMISSION_DRAIN_TTL_MS,
  );
  const effectiveIso = new Date(effectiveMs).toISOString();

  if (nowMs >= effectiveMs) {
    return { draining: false, stale: { owner: validated.data.owner, expires_at: effectiveIso } };
  }

  return {
    draining: true,
    owner: validated.data.owner,
    reason: validated.data.reason ?? null,
    set_at: validated.data.set_at,
    expires_at: effectiveIso,
    remaining_ms: effectiveMs - nowMs,
  };
}

function admissionDrainingResponse(state: ActiveAdmissionDrain): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(state.remaining_ms / 1000));
  return Response.json(
    {
      error: {
        code: "admission_draining",
        message: `daemon is draining admissions (owner ${state.owner}); retry after ${state.expires_at}`,
        retryable: true,
      },
      drain: { owner: state.owner, reason: state.reason, expires_at: state.expires_at },
      retry_after_ms: state.remaining_ms,
    },
    { status: 503, headers: { "retry-after": String(retryAfterSeconds) } },
  );
}

export function admissionDrainGuard(services: DrainServices): Response | null {
  const state = readAdmissionDrain(services.storageRoot, services.clock());
  return state.draining ? admissionDrainingResponse(state) : null;
}

function isInFlightParent(services: ContinuationServices, parentHandoffId: unknown): boolean {
  return (
    typeof parentHandoffId === "string" &&
    services.handoffReader.get(parentHandoffId)?.status === "dispatched"
  );
}

export function admissionDrainGuardUnlessContinuation(
  services: ContinuationServices,
  parentHandoffId: string | null | undefined,
): Response | null {
  const guard = admissionDrainGuard(services);
  if (guard === null || isInFlightParent(services, parentHandoffId)) return null;
  return guard;
}

/**
 * Drain check for every in-daemon chain start (HTTP /chains/start, orchestrate
 * reactor, long-lived ticks, maestro sessions, in-process workflow steps).
 * Continuations of work admitted before the drain still run:
 * - a child whose parent_handoff_id names a handoff that is still `dispatched`;
 * - a `workflow` dispatch whose workflow_run_id names a live run registered
 *   before the drain flag was set.
 * Everything else, including long-lived ticks and orchestrate spawns, is new work
 * and gets the retryable `admission_draining` 503.
 */
export function chainStartAdmissionDrainGuard(
  services: ChainStartDrainServices,
  input: {
    dispatch_kind?: string;
    parent_handoff_id?: string | null;
    workflow_run_id?: string | null;
  },
): Response | null {
  const state = readAdmissionDrain(services.storageRoot, services.clock());
  if (!state.draining) return null;
  if (isInFlightParent(services, input.parent_handoff_id)) return null;
  if (input.dispatch_kind === "workflow" && typeof input.workflow_run_id === "string") {
    const run = services.workflowRuns?.verify(input.workflow_run_id);
    if (run && run.registered_at < new Date(state.set_at).getTime()) return null;
  }
  return admissionDrainingResponse(state);
}

export const ADMISSION_DRAIN_GATED_POST_PATHS = new Set([
  "/workflows/run",
  "/maestro/sessions",
  "/maestro/sessions/adhoc",
]);

export const LONG_LIVED_TICK_PATH = /^\/long-lived\/[^/]+\/tick$/;

export function admissionDrainRequestGuard(
  req: Request,
  pathname: string,
  services: DrainServices,
): Response | null {
  if (req.method !== "POST") return null;
  if (!ADMISSION_DRAIN_GATED_POST_PATHS.has(pathname) && !LONG_LIVED_TICK_PATH.test(pathname)) {
    return null;
  }
  return admissionDrainGuard(services);
}

const SetDrainSchema = z.strictObject({
  owner: z.string().min(1).max(200),
  ttl_ms: z.number().int().min(1).max(MAX_ADMISSION_DRAIN_TTL_MS).optional(),
  reason: z.string().max(500).optional(),
});

const ReleaseDrainSchema = z.strictObject({
  owner: z.string().min(1),
});

export async function admissionDrainSetRoute(
  req: Request,
  services: Pick<Services, "storageRoot" | "clock" | "uuid">,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  const parsed = SetDrainSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const now = services.clock();
  const state = readAdmissionDrain(services.storageRoot, now);
  if (state.draining && state.owner !== parsed.data.owner) {
    return json(
      {
        error: {
          code: "admission_drain_owned",
          message: `admission drain is owned by ${state.owner}`,
        },
        drain: { owner: state.owner, expires_at: state.expires_at },
      },
      409,
    );
  }

  const path = drainFilePath(services.storageRoot);
  if (path === null) {
    return json({ error: { code: "no_storage_root", message: "daemon has no storage root" } }, 500);
  }

  const ttlMs = parsed.data.ttl_ms ?? DEFAULT_ADMISSION_DRAIN_TTL_MS;
  const flag = {
    owner: parsed.data.owner,
    reason: parsed.data.reason ?? null,
    set_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };

  mkdirSync(services.storageRoot, { recursive: true });
  const tmpPath = `${path}.tmp-${services.uuid()}`;
  writeFileSync(tmpPath, JSON.stringify(flag));
  renameSync(tmpPath, path);

  return json(readAdmissionDrain(services.storageRoot, services.clock()));
}

export async function admissionDrainReleaseRoute(
  req: Request,
  services: Pick<Services, "storageRoot" | "clock">,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  const parsed = ReleaseDrainSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const state = readAdmissionDrain(services.storageRoot, services.clock());
  if (state.draining && state.owner !== parsed.data.owner) {
    return json(
      {
        error: {
          code: "admission_drain_owned",
          message: `admission drain is owned by ${state.owner}`,
        },
        drain: { owner: state.owner, expires_at: state.expires_at },
      },
      409,
    );
  }

  const path = drainFilePath(services.storageRoot);
  if (path === null || !existsSync(path)) {
    return json({ draining: false, released: false });
  }

  rmSync(path, { force: true });
  return json({ draining: false, released: true });
}

async function bodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
