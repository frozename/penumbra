import type { Services } from "@penumbra/core";

import { z } from "zod";

import { listPendingDreamActionsQuery } from "../dreaming/digest.js";
import { applyDreamAction, revertDreamAction } from "../dreaming/reembed.js";
import { bodyJson, json } from "./_helpers.js";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const RevertBodySchema = z.object({
  action_id: z.string().min(1),
  cascade: z.enum(["none", "force"]).default("none"),
});

export function dreamingPendingActionsRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "validation_error", message: "invalid query parameters" } }, 400);
  }
  return json(listPendingDreamActionsQuery(services.db, parsed.data));
}

export function dreamingHealthRoute(req: Request, services: Services): Response {
  const db = services.db;
  const now = Date.now();
  const uptimeMs = now - services.clock().getTime();

  const currentRunning = db
    .prepare(
      'SELECT cycle_id, started_at, phases_run FROM dream_cycles WHERE outcome = "running" ORDER BY started_at DESC LIMIT 1',
    )
    .get() as { cycle_id: string; started_at: number; phases_run: string } | null;

  const current_running_cycle = currentRunning
    ? {
        cycle_id: currentRunning.cycle_id,
        started_at: currentRunning.started_at,
        phases_completed: JSON.parse(currentRunning.phases_run || "[]") as unknown,
      }
    : null;

  const yesterdayMs = now - 24 * 60 * 60 * 1000;

  const cycles_in_last_24h = (
    db.prepare("SELECT COUNT(*) as c FROM dream_cycles WHERE started_at >= ?").get(yesterdayMs) as {
      c: number;
    }
  ).c;

  const cycles_crashed_24h = (
    db
      .prepare(
        'SELECT COUNT(*) as c FROM dream_cycles WHERE started_at >= ? AND outcome = "crashed"',
      )
      .get(yesterdayMs) as { c: number }
  ).c;

  const alerts = [];
  if (uptimeMs > 24 * 60 * 60 * 1000 && cycles_in_last_24h === 0) {
    alerts.push("dream.health.no_cycles_24h");
  }
  if (cycles_crashed_24h >= 3) {
    alerts.push("dream.health.crashed_high");
  }

  return json({
    current_running_cycle,
    cycles_in_last_24h,
    cycles_crashed_24h,
    alerts,
  });
}

interface ParsedError {
  status: number | undefined;
  code: string | undefined;
  message: string;
}

function parseStructuredError(err: unknown): ParsedError {
  const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  return {
    status: typeof obj?.status === "number" ? obj.status : undefined,
    code: typeof obj?.code === "string" ? obj.code : undefined,
    message: err instanceof Error ? err.message : typeof err === "string" ? err : "unknown_error",
  };
}

export async function dreamingRevertRoute(req: Request, services: Services): Promise<Response> {
  const parsed = RevertBodySchema.safeParse(await bodyJson(req));
  if (!parsed.success) {
    return json({ error: { code: "validation_error", message: "invalid body" } }, 400);
  }
  try {
    revertDreamAction(services.db, parsed.data.action_id, parsed.data.cascade);
    return json({ ok: true });
  } catch (err: unknown) {
    const { status, code, message } = parseStructuredError(err);
    if (message.includes("has_dependents")) {
      return json({ error: "has_dependents", details: message }, 409);
    }
    return json({ error: message, ...(code ? { code } : {}) }, status ?? 500);
  }
}

export async function dreamingApplyRoute(req: Request, services: Services): Promise<Response> {
  const body = (await req.json()) as { action_id?: string };
  if (!body.action_id) return json({ error: "missing action_id" }, 400);
  try {
    applyDreamAction(services.db, body.action_id);
    return json({ ok: true });
  } catch (err: unknown) {
    const { status, code, message } = parseStructuredError(err);
    return json({ error: message, ...(code ? { code } : {}) }, status ?? 500);
  }
}
