import type { HandoffStatus, TasksListQuery } from "@penumbra/api-contract";

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

/** Handoffs list scoped by status (and optionally agent). */
export function handoffsByStatus(status: HandoffStatus, agent?: string): readonly unknown[] {
  return agent !== undefined
    ? (["handoffs", "by-status", status, agent] as const)
    : (["handoffs", "by-status", status] as const);
}

/** Single handoff detail, scoped by handoff id. */
export function handoffDetail(id: string): readonly ["handoffs", "detail", string] {
  return ["handoffs", "detail", id] as const;
}

/** Single handoff status (reliability projection), scoped by handoff id. */
export function handoffStatus(id: string): readonly ["handoffs", "status", string] {
  return ["handoffs", "status", id] as const;
}

/** Dispatch events for a handoff, scoped by handoff id. */
export function dispatchEvents(id: string): readonly ["dispatch", "events", string] {
  return ["dispatch", "events", id] as const;
}

/** Dispatch audit report for a handoff, scoped by handoff id. */
export function dispatchAudit(id: string): readonly ["dispatch", "audit", string] {
  return ["dispatch", "audit", id] as const;
}

/** Dispatch land task, scoped by task id. */
export function dispatchLandTask(taskId: string): readonly ["dispatch", "land", "task", string] {
  return ["dispatch", "land", "task", taskId] as const;
}

/** Usage quota status. */
export function usageQuotaStatus(): readonly ["usage", "quota_status"] {
  return ["usage", "quota_status"] as const;
}

/** Subscription pressure. */
export function usageSubscriptionPressure(): readonly ["usage", "subscription_pressure"] {
  return ["usage", "subscription_pressure"] as const;
}

/** Lanes list (Handoffs module). */
export function lanesRecent(): readonly ["handoffs", "lanes", "recent"] {
  return ["handoffs", "lanes", "recent"] as const;
}

/** Registrar initiative list (Plans module). */
export function registrarList(): readonly ["registrar", "list"] {
  return ["registrar", "list"] as const;
}

/** Registrar detail (entry + phases + rollup) and journal, scoped by registrar id. */
export function registrarDetail(registrarId: string): readonly ["registrar", "detail", string] {
  return ["registrar", "detail", registrarId] as const;
}

/** Registrar events journal, scoped by registrar id. */
export function registrarEvents(id: string): readonly ["registrar", "events", string] {
  return ["registrar", "events", id] as const;
}

/** Approvals inbox handoffs queue (ApprovalItem[] shape, distinct from handoffsPending). */
export function approvalsHandoffs(): readonly ["approvals", "handoffs"] {
  return ["approvals", "handoffs"] as const;
}

/** Approvals inbox permissions queue (ApprovalItem[] shape). */
export function approvalsPermissions(): readonly ["approvals", "permissions"] {
  return ["approvals", "permissions"] as const;
}

/** Approvals inbox drafts queue (ApprovalItem[] shape, distinct from sessionNoteDrafts). */
export function approvalsDrafts(): readonly ["approvals", "drafts"] {
  return ["approvals", "drafts"] as const;
}

/** Chain messages for a conversation, scoped by conversation id. */
export function chainMessages(conversationId: string): readonly ["chains", "messages", string] {
  return ["chains", "messages", conversationId] as const;
}

/** Chain responses for a conversation, scoped by conversation id. */
export function chainResponses(conversationId: string): readonly ["chains", "responses", string] {
  return ["chains", "responses", conversationId] as const;
}

/** Chain agents list. */
export function chainAgents(): readonly ["chains", "agents"] {
  return ["chains", "agents"] as const;
}

/** Session event timeline (Sessions module). */
export function sessionEvents(): readonly ["sessions", "events"] {
  return ["sessions", "events"] as const;
}

/** Pending session-note drafts (Sessions module). */
export function sessionNoteDrafts(): readonly ["sessions", "note-drafts"] {
  return ["sessions", "note-drafts"] as const;
}

/**
 * Invalidation helper for the handoffs resource — returns BOTH the legacy
 * handoffsPending key and the approvals-handoffs key so that invalidating
 * from either module refreshes the other.
 */
export function handoffsPendingInvalidations(): readonly (readonly string[])[] {
  return [handoffsPending(), approvalsHandoffs()];
}

/**
 * Invalidation helper for the session-note drafts resource — returns BOTH
 * the sessionNoteDrafts key and the approvals-drafts key.
 */
export function sessionNoteDraftsInvalidations(): readonly (readonly string[])[] {
  return [sessionNoteDrafts(), approvalsDrafts()];
}

/** Tasks list, scoped by query filters. */
export function tasksList(query: TasksListQuery): readonly ["tasks", "list", TasksListQuery] {
  return ["tasks", "list", query] as const;
}

/** Single task detail, scoped by task id. */
export function taskDetail(id: string): readonly ["tasks", "detail", string] {
  return ["tasks", "detail", id] as const;
}

/** Task-draft escalations, scoped by project id (daemon requires project_id). */
export function taskDraftEscalations(
  projectId: string,
): readonly ["task-drafts", "escalations", string] {
  return ["task-drafts", "escalations", projectId] as const;
}
