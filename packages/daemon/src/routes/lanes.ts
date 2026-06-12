import { z } from "zod";
import type { Services, TaskClass } from "@penumbra/core";
import {
  TaskClassSchema,
  closeLane,
  getOpenLaneForImplementer,
  getLane,
  insertLane,
  recentLanes,
  type LaneGateStatus,
  LaneCloseMetadataSchema,
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
} from "@penumbra/core";

import { json } from "./_helpers.js";
const OpenLaneBodySchema = z.object({
  lane_id: z.string().min(1),
  implementer_handoff: z.string().min(1),
  task_class: TaskClassSchema,
});

const CloseLaneBodySchema = z.object({
  lane_id: z.string().min(1),
  gate_status: z.enum(["passed", "failed", "skipped", "review_debt"]),
  reviewer_handoff: z.string().min(1).optional(),
  override_reason: z.string().min(1).optional(),
  metadata: LaneCloseMetadataSchema.optional(),
});

const RecentLaneQuerySchema = z.object({
  status: z.enum(["open", "passed", "failed", "skipped", "review_debt"]).optional(),
  task_class: TaskClassSchema.optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).default(50),
});

function validationError(error: z.ZodError): Response {
  return json(
    {
      error: {
        code: "validation_error",
        message: "body failed schema validation",
        field_errors: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    },
    400,
  );
}

function routeError(code: string, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, message, ...(extra ?? {}) } }, 400);
}

function getHandoffAgent(services: Services, handoffId: string): string | null {
  const row = services.db
    .query<
      { to_agent: string | null },
      [string]
    >(`SELECT to_agent FROM handoffs WHERE handoff_id = ? LIMIT 1`)
    .get(handoffId);
  return row?.to_agent ?? null;
}

function getLaneRoundCount(services: Services, implementerHandoff: string): number {
  const row = services.db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(*) AS count FROM lane_ledger WHERE implementer_handoff = ?`)
    .get(implementerHandoff);
  return row?.count ?? 0;
}

export async function lanesOpenRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const parsed = OpenLaneBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const existing = getOpenLaneForImplementer(services.db, parsed.data.implementer_handoff);
  if (existing) {
    if (existing.task_class !== parsed.data.task_class) {
      return json(
        {
          error: {
            code: "task_class_mismatch",
            message:
              "an open lane already exists for this implementer_handoff with a different task_class",
            existing_lane_id: existing.lane_id,
            existing_task_class: existing.task_class,
            requested_task_class: parsed.data.task_class,
          },
        },
        409,
      );
    }
    return json(existing);
  }

  const ts_opened = services.clock().toISOString();
  try {
    insertLane(services.db, {
      lane_id: parsed.data.lane_id,
      ts_opened,
      task_class: parsed.data.task_class as TaskClass,
      implementer_handoff: parsed.data.implementer_handoff,
      gate_status: "open",
      recalled_memory_ids: [],
      metadata_json: "{}",
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return json({ error: "lane_already_exists" }, 409);
    }
    throw err;
  }

  // Return the full persisted lane row (not a minimal ack).
  const opened = getLane(services.db, parsed.data.lane_id);
  if (!opened) {
    throw new Error(`lane not found after insert: ${parsed.data.lane_id}`);
  }
  return json(opened);
}

export async function lanesCloseRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  // Guard against oversized metadata before schema validation
  if (raw !== null && typeof raw === "object" && "metadata" in (raw as object)) {
    const meta = (raw as Record<string, unknown>).metadata;
    if (meta !== undefined) {
      const serialized = JSON.stringify(meta);
      const byteLength = Buffer.byteLength(serialized, "utf8");
      if (byteLength > LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES) {
        return json(
          {
            error: {
              code: "metadata_too_large",
              message: `metadata exceeds ${LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES} byte limit`,
            },
          },
          400,
        );
      }
    }
  }

  const parsed = CloseLaneBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const beforeClose = getLane(services.db, parsed.data.lane_id);
  if (!beforeClose) {
    return json({ error: "unknown_lane" }, 404);
  }
  if (beforeClose.ts_closed !== null) {
    return json({ error: "lane_already_closed" }, 409);
  }
  if (
    Math.max(
      parsed.data.metadata?.round_count ?? 0,
      getLaneRoundCount(services, beforeClose.implementer_handoff),
    ) > 2 &&
    parsed.data.override_reason === undefined
  ) {
    return routeError(
      "round_count_exceeds_cap",
      "metadata.round_count must be <= 2 unless override_reason is present",
    );
  }
  if (parsed.data.reviewer_handoff !== undefined && parsed.data.override_reason === undefined) {
    const implementerAgent = getHandoffAgent(services, beforeClose.implementer_handoff);
    const reviewerAgent = getHandoffAgent(services, parsed.data.reviewer_handoff);
    // An unresolvable reviewer must reject, not skip the check — otherwise a
    // fabricated reviewer_handoff bypasses self-review prevention.
    if (reviewerAgent === null) {
      return routeError(
        "unknown_reviewer_handoff",
        "reviewer_handoff does not resolve to a known handoff",
        { reviewer_handoff: parsed.data.reviewer_handoff },
      );
    }
    if (implementerAgent !== null && implementerAgent === reviewerAgent) {
      return routeError(
        "same_agent_self_review",
        "reviewer_handoff must resolve to a different agent than implementer_handoff unless override_reason is present",
        { implementer_agent: implementerAgent, reviewer_agent: reviewerAgent },
      );
    }
  }

  const ts_closed = services.clock().toISOString();
  try {
    closeLane(services.db, parsed.data.lane_id, {
      ts_closed,
      gate_status: parsed.data.gate_status,
      reviewer_handoff: parsed.data.reviewer_handoff ?? null,
      override_reason: parsed.data.override_reason ?? null,
      metadata: parsed.data.metadata ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("not found: lane ")) {
      return json({ error: "unknown_lane" }, 404);
    }
    if (message.startsWith("conflict: lane ") && message.includes("already closed")) {
      return json({ error: "lane_already_closed" }, 409);
    }
    throw err;
  }

  const closedLane = getLane(services.db, parsed.data.lane_id);
  // The gate-outcome stamp must not silently vanish when the post-close read
  // misses; the implementer handoff is immutable across close, so the pre-close
  // snapshot is an equally valid source for it.
  const implementerHandoff = closedLane?.implementer_handoff ?? beforeClose?.implementer_handoff;
  if (implementerHandoff) {
    services.db
      .prepare(
        // Substantive terminal verdicts must survive stale duplicate closes:
        // 'passed' is never downgraded, and 'failed'/'review_debt' cannot be
        // clobbered by a later 'skipped' (duplicate auto-lane residue).
        `UPDATE agent_performance
         SET gate_outcome = CASE
           WHEN gate_outcome = 'passed' AND ? != 'passed' THEN gate_outcome
           WHEN gate_outcome IN ('failed', 'review_debt') AND ? = 'skipped' THEN gate_outcome
           ELSE ?
         END
         WHERE handoff_id = ?`,
      )
      .run(
        parsed.data.gate_status,
        parsed.data.gate_status,
        parsed.data.gate_status,
        implementerHandoff,
      );
  }

  const responseLane =
    closedLane ??
    (beforeClose
      ? {
          ...beforeClose,
          ts_closed,
          gate_status: parsed.data.gate_status,
          reviewer_handoff: parsed.data.reviewer_handoff ?? beforeClose.reviewer_handoff,
          override_reason: parsed.data.override_reason ?? beforeClose.override_reason,
          metadata_json:
            parsed.data.metadata !== undefined
              ? JSON.stringify(parsed.data.metadata)
              : beforeClose.metadata_json,
        }
      : null);

  return json(responseLane);
}

export async function lanesRecentRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = RecentLaneQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    task_class: url.searchParams.get("task_class") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return validationError(parsed.error);

  if (parsed.data.since !== undefined && Number.isNaN(Date.parse(parsed.data.since))) {
    return json(
      { error: { code: "validation_error", message: "since must be an ISO timestamp" } },
      400,
    );
  }

  const sinceIso =
    parsed.data.since !== undefined ? new Date(parsed.data.since).toISOString() : undefined;

  const lanes = recentLanes(
    services.db,
    {
      gate_status: parsed.data.status as LaneGateStatus | undefined,
      task_class: parsed.data.task_class,
      since_iso: sinceIso,
    },
    Math.min(parsed.data.limit, 200),
  );

  return json({ lanes });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
