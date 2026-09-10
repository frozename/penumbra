import type {
  DispatchAuditResponse,
  DispatchEvent,
  DispatchReliabilityReport,
  HandoffDetailResponse,
  HandoffRow,
  LaneRow,
} from "@penumbra/api-contract";

const TS_BASE = "2026-09-07T10:00:00.000Z";

export function makeHandoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: "h-abc12345",
    ts: TS_BASE,
    project_id: null,
    conversation_id: "c-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: null,
    message: "implement the handoffs module",
    status: "dispatched",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: true,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    ...overrides,
  };
}

export function makeHandoffDetail(overrides: Partial<HandoffRow> = {}): HandoffDetailResponse {
  return { handoff: makeHandoffRow(overrides) };
}

export function makeDispatchEvent(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    handoff_id: "h-abc12345",
    worker_id: "w-1",
    source: "worker",
    kind: "dispatch.start",
    ts: TS_BASE,
    meta: null,
    ...overrides,
  };
}

export function makeReliabilityReport(
  overrides: Partial<DispatchReliabilityReport> = {},
): DispatchReliabilityReport {
  return {
    handoff_id: "h-abc12345",
    status: "complete",
    terminal: true,
    trustworthy: true,
    summary: "all events present",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 10,
      response_count: 5,
      worktree_changed: true,
      dispatch_end_committed: true,
      reconciled: true,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
    },
    recommended_action: "accept",
    ...overrides,
  };
}

export function makeDispatchAuditResponse(
  overrides: Partial<DispatchReliabilityReport> = {},
): DispatchAuditResponse {
  return { report: makeReliabilityReport(overrides) };
}

export function makeLaneRow(overrides: Partial<LaneRow> = {}): LaneRow {
  return {
    lane_id: "lane-abc12345",
    ts_opened: TS_BASE,
    ts_closed: null,
    task_class: "STANDARD",
    implementer_handoff: "h-implementer-full-id",
    reviewer_handoff: null,
    gate_status: "open",
    recalled_memory_ids: [],
    recalled_query: null,
    override_reason: null,
    metadata_json: "{}",
    ...overrides,
  };
}
