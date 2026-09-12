import type { Database } from "bun:sqlite";

// This exported source is compiled in consumer projects whose aliases resolve within those packages.
import { ChainReader } from "../readers/chain.js";
import { HandoffReader } from "../readers/handoff.js";
import { type Clock, systemClock } from "../utils/clock.js";
import { DispatchEventLog } from "./dispatch-event-log.js";
import {
  classifyDispatchReliability,
  type DispatchReliabilityReport,
} from "./dispatch-reliability.js";

export interface DispatchAuditSources {
  handoffReader: Pick<HandoffReader, "get">;
  dispatchEventLog: Pick<DispatchEventLog, "listByHandoff">;
  chainReader: Pick<ChainReader, "getResponses">;
  clock: Clock;
}

function parseMetaJson(meta_json: string | null): unknown {
  if (!meta_json) return null;
  try {
    return JSON.parse(meta_json) as unknown;
  } catch {
    return null;
  }
}

function lastDispatchEnd(
  events: { kind: string; meta: unknown }[],
): { kind: string; meta: unknown } | undefined {
  return events.filter((event) => event.kind === "dispatch.end").at(-1);
}

function readWorktreeChangedSnapshot(events: { kind: string; meta: unknown }[]): boolean | null {
  const dispatchEnd = lastDispatchEnd(events);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === "object" && "worktree_changed" in meta) {
    const value = (meta as Record<string, unknown>).worktree_changed;
    if (typeof value === "boolean") return value;
  }
  return null;
}

function readDispatchEndCommitted(events: { kind: string; meta: unknown }[]): boolean | null {
  const dispatchEnd = lastDispatchEnd(events);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === "object" && "committed" in meta) {
    const value = (meta as Record<string, unknown>).committed;
    if (typeof value === "boolean") return value;
  }
  return null;
}

function readClassifierDecline(
  events: { kind: string; meta: unknown }[],
): { classifier_declined: true; decline_reason: string | null } | undefined {
  const dispatchEnd = lastDispatchEnd(events);
  const meta = dispatchEnd?.meta;
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  if (record.classifier_declined !== true) return undefined;
  return {
    classifier_declined: true,
    decline_reason: typeof record.decline_reason === "string" ? record.decline_reason : null,
  };
}

export function buildDispatchAuditReport(
  sources: DispatchAuditSources,
  handoff_id: string,
): DispatchReliabilityReport | null {
  const handoff = sources.handoffReader.get(handoff_id);
  if (!handoff) return null;

  const events = sources.dispatchEventLog.listByHandoff(handoff_id).map((event) => ({
    kind: event.kind,
    ts: event.ts,
    meta: parseMetaJson(event.meta_json),
  }));
  const responses = sources.chainReader.getResponses(handoff.conversation_id, "final");
  const responseCount = responses.length;
  const finalResponseText = responses.at(-1)?.text ?? null;

  const worktreeChanged = readWorktreeChangedSnapshot(events);
  const dispatchEndCommitted = readDispatchEndCommitted(events);

  const report = classifyDispatchReliability({
    handoff: {
      handoff_id: handoff.handoff_id,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
      chain_task_type: handoff.chain_task_type,
      use_worktree: handoff.use_worktree,
    },
    events,
    responseCount,
    finalResponseText,
    worktreeChanged,
    dispatchEndCommitted,
    reconciled: null,
    adapterStreaming: null,
    now: sources.clock(),
  });

  const classifierDecline = readClassifierDecline(events);
  if (classifierDecline) {
    report.classifier_decline = classifierDecline;
  }

  return report;
}

export function dispatchAuditSourcesFromDb(
  db: Database,
  clock: Clock = systemClock,
): DispatchAuditSources {
  const handoffReader = new HandoffReader({ db });
  const chainReader = new ChainReader(db);
  const dispatchEventLog = new DispatchEventLog(db);

  return {
    handoffReader,
    dispatchEventLog,
    chainReader,
    clock,
  };
}
