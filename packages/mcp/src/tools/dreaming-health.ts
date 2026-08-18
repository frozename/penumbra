import type { Database } from "bun:sqlite";

import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const DreamingHealthInputShape = z.object({});

export type DreamingHealthInput = z.infer<typeof DreamingHealthInputShape>;

export function dreamingHealthHandler(daemon: DaemonClient): () => Promise<TextContentEnvelope> {
  return async (): Promise<TextContentEnvelope> => toTextContent(await daemon.dreamingHealth());
}

export interface DreamingHealthAlerts {
  alerts: string[];
  cycles_in_last_24h: number;
  cycles_crashed_24h: number;
  query_rewrite_failed_24h: number;
  query_rewritten_24h: number;
}

export function getDreamingHealthAlerts(
  db: Database,
  opts: { daemonUptimeMs: number },
): DreamingHealthAlerts {
  const now = Date.now();
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

  const query_rewrite_failed_24h = (
    db
      .prepare("SELECT COUNT(*) as c FROM t0_events WHERE ts >= ? AND event_type = ?")
      .get(new Date(yesterdayMs).toISOString(), "dream_p4_query_rewrite_failed") as { c: number }
  ).c;

  const query_rewritten_24h = (
    db
      .prepare("SELECT COUNT(*) as c FROM t0_events WHERE ts >= ? AND event_type = ?")
      .get(new Date(yesterdayMs).toISOString(), "dream_p4_query_rewritten") as { c: number }
  ).c;

  const alerts: string[] = [];
  if (opts.daemonUptimeMs > 24 * 60 * 60 * 1000 && cycles_in_last_24h === 0) {
    alerts.push("dream.health.no_cycles_24h");
  }
  if (cycles_crashed_24h >= 3) {
    alerts.push("dream.health.crashed_high");
  }
  if (query_rewrite_failed_24h > 0 && query_rewritten_24h === 0) {
    alerts.push("dream.health.rewrite_failing");
  }

  return {
    alerts,
    cycles_in_last_24h,
    cycles_crashed_24h,
    query_rewrite_failed_24h,
    query_rewritten_24h,
  };
}
