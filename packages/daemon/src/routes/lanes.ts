import { z } from 'zod';
import type { Services, TaskClass } from '@penumbra/core';
import {
  TaskClassSchema, closeLane, insertLane, recentLanes, type LaneGateStatus,
  LaneCloseMetadataSchema, LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
} from '@penumbra/core';

import { json } from './_helpers.js';
import { enqueueMemoryVerifyJob } from '../workers/handoff-sweeper.js';
const OpenLaneBodySchema = z.object({
  lane_id: z.string().min(1),
  implementer_handoff: z.string().min(1),
  task_class: TaskClassSchema,
});

const CloseLaneBodySchema = z.object({
  lane_id: z.string().min(1),
  gate_status: z.enum(['passed', 'failed', 'skipped', 'review_debt']),
  reviewer_handoff: z.string().min(1).optional(),
  override_reason: z.string().min(1).optional(),
  metadata: LaneCloseMetadataSchema.optional(),
});

const RecentLaneQuerySchema = z.object({
  status: z.enum(['open', 'passed', 'failed', 'skipped', 'review_debt']).optional(),
  task_class: TaskClassSchema.optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).default(50),
});

function validationError(error: z.ZodError): Response {
  return json({
    error: {
      code: 'validation_error',
      message: 'body failed schema validation',
      field_errors: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    },
  }, 400);
}

export async function lanesOpenRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = OpenLaneBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const ts_opened = services.clock().toISOString();
  try {
    insertLane(services.db, {
      lane_id: parsed.data.lane_id,
      ts_opened,
      task_class: parsed.data.task_class as TaskClass,
      implementer_handoff: parsed.data.implementer_handoff,
      gate_status: 'open',
      recalled_memory_ids: [],
      metadata_json: '{}',
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return json({ error: 'lane_already_exists' }, 409);
    }
    throw err;
  }

  return json({ lane_id: parsed.data.lane_id, ts_opened, gate_status: 'open' });
}

export async function lanesCloseRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  // Guard against oversized metadata before schema validation
  if (raw !== null && typeof raw === 'object' && 'metadata' in (raw as object)) {
    const meta = (raw as Record<string, unknown>).metadata;
    if (meta !== undefined) {
      const serialized = JSON.stringify(meta);
      const byteLength = Buffer.byteLength(serialized, 'utf8');
      if (byteLength > LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES) {
        return json({
          error: {
            code: 'metadata_too_large',
            message: `metadata exceeds ${LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES} byte limit`,
          },
        }, 400);
      }
    }
  }

  const parsed = CloseLaneBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

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
    if (message.startsWith('not found: lane ')) {
      return json({ error: 'unknown_lane' }, 404);
    }
    if (message.startsWith('conflict: lane ') && message.includes('already closed')) {
      return json({ error: 'lane_already_closed' }, 409);
    }
    throw err;
  }

  const closedLane = services.db.query<{ implementer_handoff: string }, [string]>(
    'SELECT implementer_handoff FROM lane_ledger WHERE lane_id = ?',
  ).get(parsed.data.lane_id);
  if (!closedLane) {
    throw new Error(`lane disappeared during close: ${parsed.data.lane_id}`);
  }
  services.db.prepare(`UPDATE agent_performance SET gate_outcome = ? WHERE handoff_id = ?`)
    .run(parsed.data.gate_status, closedLane.implementer_handoff);

  if ((process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE ?? '1') !== '0') {
    enqueueMemoryVerifyJob({
      services,
      handoffId: closedLane.implementer_handoff,
      verdict: parsed.data.gate_status,
      verdictSummary: parsed.data.gate_status,
    });
  }

  const row = services.db.query<{
    lane_id: string;
    ts_opened: string;
    ts_closed: string | null;
    task_class: string;
    implementer_handoff: string;
    reviewer_handoff: string | null;
    gate_status: LaneGateStatus;
    recalled_memory_ids: string;
    recalled_query: string | null;
    override_reason: string | null;
    metadata_json: string;
  }, [string]>(
    'SELECT * FROM lane_ledger WHERE lane_id = ?',
  ).get(parsed.data.lane_id);

  return json(row ? {
    ...row,
    recalled_memory_ids: JSON.parse(row.recalled_memory_ids || '[]'),
  } : null);
}

export async function lanesRecentRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = RecentLaneQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    task_class: url.searchParams.get('task_class') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) return validationError(parsed.error);

  if (parsed.data.since !== undefined && Number.isNaN(Date.parse(parsed.data.since))) {
    return json({ error: { code: 'validation_error', message: 'since must be an ISO timestamp' } }, 400);
  }

  const lanes = recentLanes(services.db, {
    gate_status: parsed.data.status as LaneGateStatus | undefined,
    task_class: parsed.data.task_class,
    since_iso: parsed.data.since,
  }, Math.min(parsed.data.limit, 200));

  return json({ lanes });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
