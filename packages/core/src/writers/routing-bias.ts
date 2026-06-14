import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { RoutingBias } from "../readers/routing-bias.js";

const VALID_SCOPES = ["provider", "agent"] as const;
const VALID_MODES = ["boost", "divert", "exclude"] as const;

export interface SetRoutingBiasArgs {
  scope: string;
  value: string;
  mode: string;
  weight?: number | null;
  reason?: string | null;
  ttl_seconds?: number;
  expires_at?: string;
  now?: Date;
}

export interface ClearRoutingBiasArgs {
  bias_id?: string;
  scope?: string;
  value?: string;
  all?: boolean;
}

export interface ClearRoutingBiasResult {
  cleared_count: number;
}

export function setRoutingBias(db: Database, args: SetRoutingBiasArgs): RoutingBias {
  if (!(VALID_SCOPES as readonly string[]).includes(args.scope)) {
    throw new Error(`Invalid scope: ${args.scope}`);
  }
  if (!(VALID_MODES as readonly string[]).includes(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }

  let weight = args.weight ?? null;
  if (weight !== null && weight !== undefined) {
    weight = Math.max(0, Math.min(2.0, weight));
  }

  let expires_at: string;
  if (args.expires_at) {
    expires_at = args.expires_at;
  } else if (args.ttl_seconds !== undefined) {
    const now = args.now ?? new Date();
    expires_at = new Date(now.getTime() + args.ttl_seconds * 1000).toISOString();
  } else {
    throw new Error("Either expires_at or ttl_seconds must be provided");
  }

  const bias_id = randomUUID();
  const now = args.now ?? new Date();
  const created_at = now.toISOString();

  db.prepare(
    `
    INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, value, mode) DO UPDATE SET
      expires_at = excluded.expires_at,
      weight = excluded.weight,
      reason = excluded.reason
  `,
  ).run(
    bias_id,
    args.scope,
    args.value,
    args.mode,
    weight,
    args.reason ?? null,
    created_at,
    expires_at,
  );

  return db
    .prepare(
      `SELECT bias_id, scope, value, mode, weight, reason, created_at, expires_at FROM routing_bias WHERE scope = ? AND value = ? AND mode = ?`,
    )
    .get(args.scope, args.value, args.mode) as RoutingBias;
}

export function clearRoutingBias(
  db: Database,
  args: ClearRoutingBiasArgs = {},
): ClearRoutingBiasResult {
  let result: { changes: number };

  if (args.all) {
    result = db.prepare("DELETE FROM routing_bias").run();
  } else if (args.bias_id) {
    result = db.prepare("DELETE FROM routing_bias WHERE bias_id = ?").run(args.bias_id);
  } else if (args.scope && args.value) {
    result = db
      .prepare("DELETE FROM routing_bias WHERE scope = ? AND value = ?")
      .run(args.scope, args.value);
  } else {
    throw new Error("clearRoutingBias requires bias_id, (scope + value), or all:true");
  }

  return { cleared_count: result.changes };
}
