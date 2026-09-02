import {
  LONG_LIVED_TICK_STATUS_EVENT_TYPE,
  normalize,
  parseTaskDraftLifecyclePayload,
  type Services,
  type T0EventInput,
  T0EventInputSchema,
  TASK_DRAFT_LIFECYCLE_EVENT_TYPES,
  type TaskDraftLifecycleEventType,
} from "@penumbra/core";
import { ZodError } from "zod";

import { json } from "./_helpers.js";
export async function observationsRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }
  const parsed = T0EventInputSchema.safeParse(raw);
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
  const rewritten = rewriteOrValidateObservation(parsed.data);
  if (!rewritten.ok) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "task draft payload failed schema validation",
          field_errors: rewritten.error.issues.map((i) => ({
            path: ["payload_json", ...i.path],
            message: i.message,
          })),
        },
      },
      400,
    );
  }
  const ctx = {
    userId: services.machineId.get(),
    machineId: services.machineId.get(),
    now: services.clock,
    uuid: services.uuid,
    redactor: services.redactor,
  };
  const event = normalize({ ...rewritten.data, ingest_ts: undefined }, ctx);
  try {
    const eventId = services.t0Writer.write(event);
    return json({ event_id: eventId });
  } catch (err) {
    if (isSqliteError(err)) {
      if (isSqliteBusy(err)) {
        return json(
          {
            error: {
              code: "sqlite_busy",
              message: "t0_events write contended; retry shortly",
            },
          },
          503,
        );
      }
      return json(
        {
          error: {
            code: "sqlite_write_failed",
            message: err.message,
          },
        },
        500,
      );
    }
    throw err;
  }
}

function isTaskDraftLifecycleEventType(
  eventType: string,
): eventType is TaskDraftLifecycleEventType {
  return (TASK_DRAFT_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(eventType);
}

function isLongLivedTickStatusPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return typeof record.tick_id === "string" && typeof record.status === "string";
}

function rewriteOrValidateObservation(
  event: T0EventInput,
): { ok: true; data: T0EventInput } | { ok: false; error: ZodError } {
  if (!isTaskDraftLifecycleEventType(event.event_type)) {
    return { ok: true, data: event };
  }
  if (isLongLivedTickStatusPayload(event.payload_json)) {
    return {
      ok: true,
      data: {
        ...event,
        event_type: LONG_LIVED_TICK_STATUS_EVENT_TYPE,
      },
    };
  }
  try {
    parseTaskDraftLifecyclePayload(event.event_type, event.payload_json);
    return { ok: true, data: event };
  } catch (error) {
    if (error instanceof ZodError) return { ok: false, error };
    throw error;
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function isSqliteError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && err.name === "SQLiteError";
}

function isSqliteBusy(err: Error & { code?: string }): boolean {
  if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("database is locked") || msg.includes("database is busy");
}
