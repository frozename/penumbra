import type { Database } from "bun:sqlite";

export interface RoutingBias {
  bias_id: string;
  scope: "provider" | "agent";
  value: string;
  mode: "boost" | "divert" | "exclude";
  weight: number | null;
  reason: string | null;
  created_at: string;
  expires_at: string;
}

export interface ReadRoutingBiasesOpts {
  now?: Date;
  scope?: "provider" | "agent";
  value?: string;
}

export function readRoutingBiases(db: Database, opts: ReadRoutingBiasesOpts = {}): RoutingBias[] {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const conditions: string[] = ["expires_at > ?"];
  const params: string[] = [nowIso];

  if (opts.scope) {
    conditions.push("scope = ?");
    params.push(opts.scope);
  }
  if (opts.value) {
    conditions.push("value = ?");
    params.push(opts.value);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  return db
    .prepare(
      `SELECT bias_id, scope, value, mode, weight, reason, created_at, expires_at FROM routing_bias ${where} ORDER BY created_at DESC`,
    )
    .all(...params) as RoutingBias[];
}
