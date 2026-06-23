import {
  closeLane,
  getClosedLaneRoundCountForHandoffLineage,
  getHandoffToAgent,
  getLane,
  getOpenLaneForImplementer,
  insertLane,
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
  LaneCloseMetadataSchema,
  RecallRequestSchema,
  type RecallResult,
  recentLanes,
  type Services,
  type TaskClass,
  TaskClassSchema,
} from "@penumbra/core";
import { z } from "zod";

import { autoRecallForDispatch } from "../dispatch/auto-recall.js";
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

function routeError(
  code: string,
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
): Response {
  return json({ error: { code, message, ...(extra ?? {}) } }, status);
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

  const openLane = getOpenLaneForImplementer(services.db, parsed.data.implementer_handoff);
  if (openLane) {
    if (openLane.task_class !== parsed.data.task_class) {
      return json(
        {
          error: {
            code: "task_class_mismatch",
            message:
              "an open lane already exists for this implementer_handoff with a different task_class",
            existing_lane_id: openLane.lane_id,
            existing_task_class: openLane.task_class,
            requested_task_class: parsed.data.task_class,
          },
        },
        409,
      );
    }
    return json({ ...openLane, adopted: true });
  }

  const ts_opened = services.clock().toISOString();
  const recall = await recallForManualOpen(
    services,
    parsed.data.implementer_handoff,
    parsed.data.task_class,
  );
  try {
    insertLane(services.db, {
      lane_id: parsed.data.lane_id,
      ts_opened,
      task_class: parsed.data.task_class,
      implementer_handoff: parsed.data.implementer_handoff,
      gate_status: "open",
      recalled_memory_ids: recall.recalled_memory_ids,
      recalled_query: recall.recalled_query,
      metadata_json: "{}",
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return routeError("lane_already_exists", "lane_id already exists", 409);
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

async function recallForManualOpen(
  services: Services,
  implementer_handoff: string,
  task_class: TaskClass,
): Promise<{ recalled_memory_ids: string[]; recalled_query: string | null }> {
  const handoff = services.db
    .query<
      { message: string; project_id: string | null },
      [string]
    >(`SELECT message, project_id FROM handoffs WHERE handoff_id = ? LIMIT 1`)
    .get(implementer_handoff);
  if (!handoff?.project_id) {
    return { recalled_memory_ids: [], recalled_query: null };
  }

  const auto = await autoRecallForDispatch(
    {
      prompt: handoff.message,
      task_class,
      project_id: handoff.project_id,
    },
    {
      memoryRecall: async (args) => {
        const recallReq = RecallRequestSchema.parse({
          query: args.query,
          limit: args.top_k,
          project_id: args.project_id ?? null,
        });
        const results: RecallResult[] = await services.recallReader.recall(recallReq);
        return {
          hits: results.map((r) => ({
            id: r.id,
            title: r.title ?? "",
            snippet: r.body,
            tier: r.tier,
          })),
        };
      },
      logger: (level, msg, meta): void => {
        services.log[level]({ ...meta, event: "lane.open.auto_recall" }, msg);
      },
    },
  );
  return {
    recalled_memory_ids: auto.recalled_memory_ids,
    recalled_query: auto.recalled_query || null,
  };
}

type CloseLaneBody = z.infer<typeof CloseLaneBodySchema>;

function checkMetadataSize(raw: unknown): Response | null {
  if (typeof raw !== "object" || raw === null || !("metadata" in raw)) return null;
  const meta = (raw as Record<string, unknown>).metadata;
  if (meta === undefined) return null;
  const serialized = JSON.stringify(meta);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES) return null;
  return json(
    {
      error: {
        code: "metadata_too_large",
        message: `metadata exceeds ${String(LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES)} byte limit`,
      },
    },
    400,
  );
}

function applyRoundCountCap(
  services: Services,
  implementerHandoff: string,
  body: CloseLaneBody,
): { overrides: string[] } | { error: Response } {
  const overrides: string[] = [];
  const metadataRoundCount = body.metadata?.round_count;
  // Everything from this read to the close transaction is synchronous (no
  // awaits), so a concurrent close cannot interleave between the lineage
  // count and the commit within a single daemon process. The two cap checks
  // use different denominators by design: metadata.round_count is the
  // caller's self-reported CURRENT round (cap reached at >2), while the
  // lineage count is the number of PRIOR closed rounds (this close would be
  // round count+1, so it rejects at >=2).
  const closedLineageRoundCount = getClosedLaneRoundCountForHandoffLineage(
    services.db,
    implementerHandoff,
  );
  if (metadataRoundCount !== undefined && metadataRoundCount > 2) {
    if (body.override_reason === undefined) {
      return {
        error: routeError(
          "round_count_exceeds_cap",
          "metadata.round_count must be <= 2 unless override_reason is present",
        ),
      };
    }
    overrides.push("round_count_exceeds_cap");
  }
  if (closedLineageRoundCount >= 2) {
    if (body.override_reason === undefined) {
      return {
        error: routeError(
          "round_count_exceeds_cap",
          "closed lane rounds for this handoff lineage must be <= 2 unless override_reason is present",
        ),
      };
    }
    if (!overrides.includes("round_count_exceeds_cap")) {
      overrides.push("round_count_exceeds_cap");
    }
  }
  return { overrides };
}

function applyReviewerHandoffCheck(
  services: Services,
  implementerHandoff: string,
  body: CloseLaneBody,
): { overrides: string[] } | { error: Response } {
  if (body.reviewer_handoff === undefined) return { overrides: [] };
  const implementerAgent = getHandoffToAgent(services.db, implementerHandoff);
  const reviewerAgent = getHandoffToAgent(services.db, body.reviewer_handoff);
  if (body.override_reason === undefined) {
    return enforceReviewerHandoffStrict({
      implementerAgent,
      reviewerAgent,
      implementerHandoff,
      reviewerHandoff: body.reviewer_handoff,
    });
  }
  const overrides: string[] = [];
  if (reviewerAgent === null) {
    overrides.push("unknown_reviewer_handoff");
  } else if (implementerAgent !== null && implementerAgent === reviewerAgent) {
    overrides.push("same_agent_self_review");
  }
  return { overrides };
}

function enforceReviewerHandoffStrict(args: {
  implementerAgent: string | null;
  reviewerAgent: string | null;
  implementerHandoff: string;
  reviewerHandoff: string;
}): { overrides: string[] } | { error: Response } {
  // Unresolvable handoffs on EITHER side must reject, not skip the check —
  // otherwise a fabricated id bypasses self-review prevention (null never
  // equals the other side's agent).
  if (args.reviewerAgent === null) {
    return {
      error: routeError(
        "unknown_reviewer_handoff",
        "reviewer_handoff does not resolve to a known handoff",
        400,
        { reviewer_handoff: args.reviewerHandoff },
      ),
    };
  }
  if (args.implementerAgent === null) {
    return {
      error: routeError(
        "unknown_implementer_handoff",
        "the lane's implementer_handoff does not resolve to a known handoff; close with override_reason to acknowledge",
        400,
        { implementer_handoff: args.implementerHandoff },
      ),
    };
  }
  if (args.implementerAgent === args.reviewerAgent) {
    return {
      error: routeError(
        "same_agent_self_review",
        "reviewer_handoff must resolve to a different agent than implementer_handoff unless override_reason is present",
        400,
        { implementer_agent: args.implementerAgent, reviewer_agent: args.reviewerAgent },
      ),
    };
  }
  return { overrides: [] };
}

function commitLaneClose(
  services: Services,
  body: CloseLaneBody,
  ts_closed: string,
): Response | null {
  try {
    // The close commits atomically inside the transaction; closeLane stamps the
    // matching agent_performance row as part of the same mutation path.
    // The live-bus override events publish AFTER the commit — event delivery
    // is not rollbackable and must not fire for a rolled-back close.
    services.db.transaction(() => {
      closeLane(services.db, body.lane_id, {
        ts_closed,
        gate_status: body.gate_status,
        reviewer_handoff: body.reviewer_handoff ?? null,
        override_reason: body.override_reason ?? null,
        metadata: body.metadata ?? undefined,
      });
    })();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("not found: lane ")) {
      return routeError("unknown_lane", "lane_id does not exist", 404);
    }
    if (message.startsWith("conflict: lane ") && message.includes("already closed")) {
      return routeError("lane_already_closed", "lane is already closed", 409);
    }
    throw err;
  }
}

function emitOverrideAuditEvents(
  services: Services,
  implementerHandoff: string,
  body: CloseLaneBody,
  ts_closed: string,
  overriddenControls: readonly string[],
): void {
  // Audit events publish after the commit (live-bus delivery is not
  // rollbackable, so it must never fire for a rolled-back close). The close is
  // the authoritative record: an audit-write failure is logged loudly but must
  // not surface as an error for a close that already persisted.
  for (const control of overriddenControls) {
    try {
      services.dispatchEventLog.record({
        handoff_id: implementerHandoff,
        source: "daemon",
        kind: "lane.override",
        ts: ts_closed,
        meta: {
          control,
          lane_id: body.lane_id,
          gate_status: body.gate_status,
          override_reason: body.override_reason,
        },
      });
    } catch (err) {
      services.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          lane_id: body.lane_id,
          control,
        },
        "lane.override audit event failed after close committed",
      );
    }
  }
}

export async function lanesCloseRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  // Guard against oversized metadata before schema validation
  const metadataTooLarge = checkMetadataSize(raw);
  if (metadataTooLarge) return metadataTooLarge;

  const parsed = CloseLaneBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const beforeClose = getLane(services.db, parsed.data.lane_id);
  if (!beforeClose) {
    return routeError("unknown_lane", "lane_id does not exist", 404);
  }
  if (beforeClose.ts_closed !== null) {
    return routeError("lane_already_closed", "lane is already closed", 409);
  }
  const roundCapResult = applyRoundCountCap(services, beforeClose.implementer_handoff, parsed.data);
  if ("error" in roundCapResult) return roundCapResult.error;
  const reviewerResult = applyReviewerHandoffCheck(
    services,
    beforeClose.implementer_handoff,
    parsed.data,
  );
  if ("error" in reviewerResult) return reviewerResult.error;
  const overriddenControls = [...roundCapResult.overrides, ...reviewerResult.overrides];

  const ts_closed = services.clock().toISOString();
  const commitErr = commitLaneClose(services, parsed.data, ts_closed);
  if (commitErr) return commitErr;

  emitOverrideAuditEvents(
    services,
    beforeClose.implementer_handoff,
    parsed.data,
    ts_closed,
    overriddenControls,
  );

  const closedLane = getLane(services.db, parsed.data.lane_id);

  const responseLane = closedLane ?? {
    ...beforeClose,
    ts_closed,
    gate_status: parsed.data.gate_status,
    reviewer_handoff: parsed.data.reviewer_handoff ?? beforeClose.reviewer_handoff,
    override_reason: parsed.data.override_reason ?? beforeClose.override_reason,
    metadata_json:
      parsed.data.metadata !== undefined
        ? JSON.stringify(parsed.data.metadata)
        : beforeClose.metadata_json,
  };

  return json(responseLane);
}

export function lanesRecentRoute(req: Request, services: Services): Response {
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
      gate_status: parsed.data.status,
      task_class: parsed.data.task_class,
      since_iso: sinceIso,
    },
    Math.min(parsed.data.limit, 200),
  );

  return json({ lanes });
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
