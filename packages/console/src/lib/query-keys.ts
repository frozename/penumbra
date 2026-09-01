import type { HandoffStatus } from "@penumbra/api-contract";

/**
 * Centralized TanStack Query key registry.
 *
 * Why this exists: query keys identify cache entries. When two components use
 * different keys for the same data they double-fetch and don't share
 * invalidation. Importing constants from this module enforces a single key
 * per logical resource so cache and invalidation behavior stay coherent.
 *
 * Adding a key: define a function that returns a tuple `as const` and update
 * the section comment with the consumers.
 */

/** Pending handoffs list. */
export function handoffsPending(): readonly ["handoffs", "pending"] {
  return ["handoffs", "pending"] as const;
}

/** Daemon workspace (repo identity + git state) for the Explorer PROJECT card. */
export function workspace(): readonly ["workspace"] {
  return ["workspace"] as const;
}

/** Chains list, scoped by latest_status. */
export function chainsByStatus(
  status: HandoffStatus,
  opts?: { limit?: number },
): readonly unknown[] {
  return opts?.limit !== undefined
    ? (["chains", status, { limit: opts.limit }] as const)
    : (["chains", status] as const);
}

/** Usage quota status. */
export function usageQuotaStatus(): readonly ["usage", "quota_status"] {
  return ["usage", "quota_status"] as const;
}

/** Subscription pressure. */
export function usageSubscriptionPressure(): readonly ["usage", "subscription_pressure"] {
  return ["usage", "subscription_pressure"] as const;
}

/** Registrar initiative list (Plans module). */
export function registrarList(): readonly ["registrar", "list"] {
  return ["registrar", "list"] as const;
}

/** Registrar detail (entry + phases + rollup) and journal, scoped by registrar id. */
export function registrarDetail(registrarId: string): readonly ["registrar", "detail", string] {
  return ["registrar", "detail", registrarId] as const;
}

/** Session event timeline (Sessions module). */
export function sessionEvents(): readonly ["sessions", "events"] {
  return ["sessions", "events"] as const;
}

/** Pending session-note drafts (Sessions module). */
export function sessionNoteDrafts(): readonly ["sessions", "note-drafts"] {
  return ["sessions", "note-drafts"] as const;
}
