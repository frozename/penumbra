import { createHash } from "node:crypto";
import type { AgentPerformanceRow, AgentTaskType } from "../schemas/agent-performance.js";
import type { TaskEvent } from "./event-bus.js";
import type { TaskRecord } from "./schema.js";
import type { TaskLeaseRow } from "./writer.js";

export interface LedgerWrite {
  agent_name: string;
  task_type: AgentTaskType;
  success: boolean;
  failure_reason: string | null;
}

function taskSizeTaskType(taskRow: TaskRecord): AgentTaskType {
  const artifacts = taskRow.result_artifacts;
  if (Array.isArray(artifacts) && artifacts.length <= 1) {
    return "implement_small";
  }
  return "implement_substantial";
}

function deriveTaskType(taskRow: TaskRecord): AgentTaskType {
  if (taskRow.kind === "review") return "review_adversarial";
  return taskSizeTaskType(taskRow);
}

export function mapTaskEventToLedger(
  event: TaskEvent,
  taskRow: TaskRecord,
  leaseRow?: TaskLeaseRow,
): LedgerWrite | null {
  if (event.kind === "completed" && taskRow.kind === "work" && taskRow.status === "done") {
    if (!leaseRow?.agent_id) return null;
    return {
      agent_name: leaseRow.agent_id,
      task_type: taskSizeTaskType(taskRow),
      success: true,
      failure_reason: null,
    };
  }

  if (event.kind === "review_passed") {
    if (!leaseRow?.agent_id) return null;
    return {
      agent_name: leaseRow.agent_id,
      task_type: taskSizeTaskType(taskRow),
      success: true,
      failure_reason: null,
    };
  }

  if (event.kind === "review_failed") {
    if (!leaseRow?.agent_id) return null;
    return {
      agent_name: leaseRow.agent_id,
      task_type: taskSizeTaskType(taskRow),
      success: false,
      failure_reason: taskRow.failure_reason,
    };
  }

  if (event.kind === "completed" && taskRow.kind === "review" && taskRow.status === "done") {
    if (!leaseRow?.agent_id) return null;
    return {
      agent_name: leaseRow.agent_id,
      task_type: "review_adversarial",
      success: true,
      failure_reason: null,
    };
  }

  if (event.kind === "released" && event.payload?.reason === "expired") {
    if (!leaseRow?.agent_id) return null;
    return {
      agent_name: leaseRow.agent_id,
      task_type: deriveTaskType(taskRow),
      success: false,
      failure_reason: "lease expired",
    };
  }

  return null;
}

function stableTaskLedgerId(input: {
  task_id: string;
  at: number;
  kind: string;
  agent_name: string;
  task_type: string;
  success: boolean;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        input.task_id,
        String(input.at),
        input.kind,
        input.agent_name,
        input.task_type,
        input.success ? "1" : "0",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 20);
  return `task:${hash}`;
}

export function ledgerWriteToPerformanceRow(opts: {
  write: LedgerWrite;
  taskEvent: TaskEvent;
  project_id?: string | null;
  clock: () => Date;
  uuid: () => string;
}): AgentPerformanceRow {
  const nowIso = opts.clock().toISOString();
  const handoffId = stableTaskLedgerId({
    task_id: opts.taskEvent.task_id,
    at: opts.taskEvent.at,
    kind: opts.taskEvent.kind,
    agent_name: opts.write.agent_name,
    task_type: opts.write.task_type,
    success: opts.write.success,
  });
  return {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: handoffId,
    conversation_id: null,
    project_id: opts.project_id ?? null,
    agent_name: opts.write.agent_name,
    task_type: opts.write.task_type,
    outcome: opts.write.success ? "merged" : "failed",
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: null,
    tokens_used: null,
    latency_ms: null,
    source: "operator",
    notes: opts.write.failure_reason,
    metadata_json: JSON.stringify({
      source: "task_board_ledger",
      task_id: opts.taskEvent.task_id,
      event_kind: opts.taskEvent.kind,
      event_at: opts.taskEvent.at,
    }),
  };
}
