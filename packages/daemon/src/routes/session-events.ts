import type { Services, SessionEventInput, SessionEventRow } from "@penumbra/core";

import { SessionEventKindSchema, SessionEventsQuerySchema } from "@penumbra/api-contract";
import { z } from "zod";

import { json } from "./_helpers.js";

const KIND_VALUES = [
  ...SessionEventKindSchema.options,
] as const satisfies readonly SessionEventInput["kind"][];

const EventSchema = z.object({
  session_id: z.string().min(1),
  related_session_id: z.string().nullish(),
  project_id: z.string().nullish(),
  cwd: z.string().nullish(),
  transcript_path: z.string().nullish(),
  ref_path: z.string().nullish(),
  kind: z.enum(KIND_VALUES),
  ts: z.string().min(1),
  meta: z.unknown().nullish(),
});

const BatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

function hydrateRow(row: SessionEventRow): Record<string, unknown> {
  return {
    id: row.id,
    session_id: row.session_id,
    related_session_id: row.related_session_id,
    project_id: row.project_id,
    cwd: row.cwd,
    transcript_path: row.transcript_path,
    ref_path: row.ref_path,
    kind: row.kind,
    ts: row.ts,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as unknown) : null,
  };
}

function validateMetaSize(events: SessionEventInput[]): Response | null {
  for (const event of events) {
    if (event.meta === undefined || event.meta === null) continue;
    const serialized = JSON.stringify(event.meta);
    if (Buffer.byteLength(serialized, "utf8") > 8192) {
      return json(
        {
          error: "meta_too_large",
          message: "meta JSON must be <= 8192 bytes",
        },
        400,
      );
    }
  }
  return null;
}

export async function sessionEventsPostRoute(req: Request, services: Services): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  const sizeError = validateMetaSize(parsed.data.events);
  if (sizeError) return sizeError;

  services.sessionEventLog.recordBatch(parsed.data.events);
  return json({ recorded: parsed.data.events.length });
}

export function sessionEventsGetRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = SessionEventsQuerySchema.safeParse({
    session_id: url.searchParams.get("session_id") ?? undefined,
    kind_prefix: url.searchParams.get("kind_prefix") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, 400);

  const events = services.sessionEventLog.listRecent(parsed.data).map(hydrateRow);
  return json({ events });
}
