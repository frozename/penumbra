import type { Services, SessionEventRow, SessionNoteDraftRow } from "@penumbra/core";

import {
  type SessionNoteApproveRequest,
  SessionNoteApproveRequestSchema,
  SessionNoteApproveResponseSchema,
  SessionNoteDraftsListResponseSchema,
  SessionNoteDraftsQuerySchema,
} from "@penumbra/api-contract";
import { emitFileOutput } from "@penumbra/workflows";
import { readFile } from "node:fs/promises";

import { getPrincipal } from "../auth.js";
import { json } from "./_helpers.js";

type HydratedSessionEvent = Omit<SessionEventRow, "meta_json"> & { meta: unknown };

type ApprovePayload =
  | { ok: true; data: SessionNoteApproveRequest }
  | { ok: false; response: Response };

function hydrateEvent(row: SessionEventRow): HydratedSessionEvent {
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

function findPairedComposedEvent(
  services: Services,
  draft: SessionNoteDraftRow,
): SessionEventRow | null {
  if (draft.composed_event_id !== null) {
    return (
      services.db
        .query<SessionEventRow, [number]>(
          `SELECT * FROM session_events
           WHERE id = ?
             AND kind = 'continuity.draft_composed'
           LIMIT 1`,
        )
        .get(draft.composed_event_id) ?? null
    );
  }
  return (
    services.db
      .query<SessionEventRow, [string, string]>(
        `SELECT * FROM session_events
         WHERE kind = 'continuity.draft_composed'
           AND (
             ref_path = ?
             OR (
               meta_json IS NOT NULL
               AND json_valid(meta_json)
               AND json_extract(meta_json, '$.draft_id') = ?
             )
           )
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(draft.draft_path, draft.draft_id) ?? null
  );
}

function latestReviewedEvent(
  services: Services,
  draft: SessionNoteDraftRow,
): HydratedSessionEvent | null {
  const row =
    services.db
      .query<SessionEventRow, [string, string]>(
        `SELECT * FROM session_events
         WHERE kind = 'continuity.draft_reviewed'
           AND ref_path = ?
           AND meta_json IS NOT NULL
           AND json_valid(meta_json)
           AND json_extract(meta_json, '$.draft_id') = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(draft.note_path, draft.draft_id) ?? null;
  return row ? hydrateEvent(row) : null;
}

function latencyMs(reviewedAt: string, composed: SessionEventRow | null): number | null {
  if (!composed) return null;
  const reviewed = Date.parse(reviewedAt);
  const composedAt = Date.parse(composed.ts);
  if (!Number.isFinite(reviewed) || !Number.isFinite(composedAt)) return null;
  // Clock skew or backfilled compose events must not produce negative telemetry.
  return Math.max(0, reviewed - composedAt);
}

async function parseApprovePayload(req: Request): Promise<ApprovePayload> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
  const parsed = SessionNoteApproveRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      response: json({ error: "invalid_payload", issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

async function readDraftBody(
  draft: SessionNoteDraftRow,
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await readFile(draft.draft_path, "utf8") };
  } catch (err) {
    return {
      ok: false,
      response: json(
        { error: "draft_read_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      ),
    };
  }
}

function recordReviewedEvent(input: {
  services: Services;
  draft: SessionNoteDraftRow;
  composed: SessionEventRow | null;
  reviewedAt: string;
  outcome: "approved" | "edited";
  body: string;
  draftBody: string;
}): HydratedSessionEvent | null {
  input.services.sessionEventLog.record({
    session_id: input.draft.session_id,
    related_session_id: input.composed?.related_session_id ?? null,
    project_id: input.draft.project_id,
    cwd: input.composed?.cwd ?? null,
    transcript_path: input.composed?.transcript_path ?? null,
    ref_path: input.draft.note_path,
    kind: "continuity.draft_reviewed",
    ts: input.reviewedAt,
    meta: {
      outcome: input.outcome,
      draft_id: input.draft.draft_id,
      diff_len: input.outcome === "edited" ? input.body.length - input.draftBody.length : 0,
      latency_ms: latencyMs(input.reviewedAt, input.composed),
    },
  });
  return latestReviewedEvent(input.services, input.draft);
}

function noteWriteFailedResponse(input: {
  services: Services;
  draft_id: string;
  warnings: string[];
}): Response {
  try {
    const reverted = input.services.sessionNoteDrafts.revertApproval(input.draft_id);
    if (!reverted) {
      input.services.log.warn(
        { draft_id: input.draft_id },
        "session note draft approval revert changed no rows after note write failure",
      );
      return json(
        { error: "note_write_failed", warnings: input.warnings, state: "inconsistent" },
        500,
      );
    }
  } catch (err) {
    input.services.log.warn(
      { err, draft_id: input.draft_id },
      "session note draft approval revert failed after note write failure",
    );
    return json(
      { error: "note_write_failed", warnings: input.warnings, state: "inconsistent" },
      500,
    );
  }
  return json({ error: "note_write_failed", warnings: input.warnings }, 500);
}

export async function sessionNotesApproveRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const principal = getPrincipal(req);
  if (!principal || principal.kind === "worker") return json({ error: "forbidden" }, 403);

  const parsed = await parseApprovePayload(req);
  if (!parsed.ok) return parsed.response;

  const draft = services.sessionNoteDrafts.get(parsed.data.draft_id);
  if (!draft) return json({ error: "not_found" }, 404);

  const draftBodyResult = await readDraftBody(draft);
  if (!draftBodyResult.ok) return draftBodyResult.response;

  const reviewedAt = services.clock().toISOString();
  const composed = findPairedComposedEvent(services, draft);
  const body = parsed.data.body ?? draftBodyResult.body;
  const outcome = parsed.data.body === undefined ? "approved" : "edited";
  const approved = services.sessionNoteDrafts.approve({
    draft_id: parsed.data.draft_id,
    body: parsed.data.body,
    reviewed_at: reviewedAt,
    review_event_id: null,
  });
  if (!approved.ok) {
    if (approved.code === "not_found") return json({ error: "not_found" }, 404);
    return json({ error: "conflict" }, 409);
  }

  const write = await emitFileOutput({
    path: approved.draft.note_path,
    body,
    mode: "overwrite",
  });
  if (write.warnings.length > 0) {
    return noteWriteFailedResponse({
      services,
      draft_id: approved.draft.draft_id,
      warnings: write.warnings,
    });
  }

  try {
    const event = recordReviewedEvent({
      services,
      draft: approved.draft,
      composed,
      reviewedAt,
      outcome,
      body,
      draftBody: draftBodyResult.body,
    });
    const stamped =
      event?.id === undefined
        ? approved.draft
        : services.sessionNoteDrafts.setReviewEventId(approved.draft.draft_id, event.id);
    return json(SessionNoteApproveResponseSchema.parse({ draft: stamped, event }));
  } catch (err) {
    services.log.warn(
      { err, draft_id: approved.draft.draft_id },
      "session note draft review event failed after note write",
    );
    return json(SessionNoteApproveResponseSchema.parse({ draft: approved.draft, event: null }));
  }
}

export function sessionNotesDraftsRoute(req: Request, services: Services): Response {
  const principal = getPrincipal(req);
  if (!principal || principal.kind === "worker") return json({ error: "forbidden" }, 403);

  const url = new URL(req.url);
  const parsed = SessionNoteDraftsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  return json(
    SessionNoteDraftsListResponseSchema.parse({
      drafts: services.sessionNoteDrafts.list(parsed.data),
    }),
  );
}
