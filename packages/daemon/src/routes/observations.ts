import type { Services } from "@penumbra/core";
import { normalize, T0EventInputSchema } from "@penumbra/core";
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
  const ctx = {
    userId: services.machineId.get(),
    machineId: services.machineId.get(),
    now: services.clock,
    uuid: services.uuid,
    redactor: services.redactor,
  };
  const event = normalize(parsed.data, ctx);
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

async function safeJson(req: Request): Promise<unknown | null> {
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
