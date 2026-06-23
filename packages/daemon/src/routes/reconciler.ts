import type { Services } from "@penumbra/core";

import { z } from "zod";

import { runPrOrphanSweepForDaemon } from "../services/pr-orphan-sweep.js";
import { bodyJson, json } from "./_helpers.js";

const SweepInputSchema = z.object({
  dry_run: z.boolean().optional(),
  max_close: z.number().int().positive().optional(),
});

const VerdictsQuerySchema = z.object({
  since: z
    .string()
    .optional()
    .refine((value) => value === undefined || !Number.isNaN(Date.parse(value)), {
      message: "since must be an ISO timestamp",
    }),
  limit: z.coerce.number().int().positive().max(500).optional().default(50),
  only_unverified: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

function parsePayloadJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // ignored
  }
  return {};
}

interface VerdictRow {
  event_id: string;
  ts: string;
  session_id: string | null;
  payload_json: string;
  handoff_id: string | null;
  handoff_conversation_id: string | null;
  project_id: string | null;
  to_agent: string | null;
  to_role: string | null;
  chain_task_type: string | null;
  handoff_status: string | null;
  handoff_message: string | null;
  branch_base: string | null;
}

type VerdictQueryParam = string | number;

export function reconcilerVerdictsRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = VerdictsQuerySchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    only_unverified: url.searchParams.get("only_unverified") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }

  const clauses = [`e.event_type='reconciler.verdict'`];
  const params: VerdictQueryParam[] = [];
  if (parsed.data.since) {
    const sinceUtc = new Date(parsed.data.since).toISOString();
    clauses.push("e.ts >= ?");
    params.push(sinceUtc);
  }
  if (parsed.data.only_unverified) {
    clauses.push(`json_extract(e.payload_json, '$.pr_url') IS NULL`);
  }
  params.push(parsed.data.limit);

  const rows = services.db
    .query<VerdictRow, VerdictQueryParam[]>(
      `SELECT
         e.event_id,
         e.ts,
         e.session_id,
         e.payload_json,
         h.handoff_id,
         h.conversation_id AS handoff_conversation_id,
         h.project_id,
         h.to_agent,
         h.to_role,
         h.chain_task_type,
         h.status AS handoff_status,
         h.message AS handoff_message,
         h.branch_base
       FROM t0_events e
       LEFT JOIN handoffs h
         ON h.handoff_id = CAST(json_extract(e.payload_json, '$.handoff_id') AS TEXT)
       WHERE ${clauses.join(" AND ")}
       ORDER BY e.ts DESC, e.event_id DESC
       LIMIT ?`,
    )
    .all(...params);

  const verdicts = rows.map((row) => {
    const verdict = parsePayloadJson(row.payload_json);
    const payloadConversation =
      typeof verdict.conversation_id === "string" ? verdict.conversation_id : null;
    const payloadHandoff = typeof verdict.handoff_id === "string" ? verdict.handoff_id : null;
    return {
      event_id: row.event_id,
      ts: row.ts,
      handoff_id: row.handoff_id ?? payloadHandoff,
      conversation_id: row.handoff_conversation_id ?? payloadConversation ?? row.session_id,
      project_id: row.project_id,
      to_agent: row.to_agent,
      to_role: row.to_role,
      chain_task_type: row.chain_task_type,
      handoff_status: row.handoff_status,
      handoff_message: row.handoff_message,
      branch_base: row.branch_base,
      verdict,
    };
  });

  return json({ verdicts });
}

export async function reconcilerSweepOrphanPrsRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await bodyJson(req);
  const parsed = SweepInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }

  const result = await runPrOrphanSweepForDaemon({
    services,
    dryRun: parsed.data.dry_run ?? services.settings.prOrphanSweeperDryRun,
    maxClose: parsed.data.max_close,
  });

  return json(result);
}
