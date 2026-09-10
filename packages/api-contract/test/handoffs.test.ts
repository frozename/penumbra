import { expect, test } from "bun:test";

import {
  HandoffDetailResponseSchema,
  HandoffFailRequestSchema,
  HandoffsListQuerySchema,
  HandoffStatusResponseSchema,
} from "../src/index.js";

// project_id and project_scope are mutually exclusive at the route (validateProjectScopeQuery, routes/handoffs.ts:541-550 answers 400); the schema does not encode that.

test("HandoffsListQuerySchema accepts agent, project_id and project_scope and rejects unknown keys", () => {
  expect(HandoffsListQuerySchema.safeParse({ agent: "x", project_id: "p" }).success).toBe(true);
  expect(HandoffsListQuerySchema.safeParse({ agent: "x", project_scope: "global" }).success).toBe(
    true,
  );
  expect(HandoffsListQuerySchema.safeParse({ bogus: 1 }).success).toBe(false);
});

test("HandoffFailRequestSchema requires reason min 1", () => {
  expect(HandoffFailRequestSchema.safeParse({ reason: "x" }).success).toBe(true);
  expect(HandoffFailRequestSchema.safeParse({ reason: "" }).success).toBe(false);
  expect(HandoffFailRequestSchema.safeParse({}).success).toBe(false);
});

test("HandoffFailRequestSchema accepts optional worker_id", () => {
  expect(HandoffFailRequestSchema.safeParse({ reason: "x", worker_id: "w1" }).success).toBe(true);
  expect(HandoffFailRequestSchema.safeParse({ reason: "x" }).success).toBe(true);
});

test("HandoffDetailResponseSchema is loose {handoff: HandoffRowSchema}", () => {
  const handoff = {
    handoff_id: "h1",
    ts: "2026-01-01T00:00:00.000Z",
    project_id: null,
    conversation_id: "c1",
    from_agent: "claude",
    to_agent: "gemini",
    to_role: null,
    message: "go",
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };
  const parsed = HandoffDetailResponseSchema.safeParse({
    handoff,
    extra: "allowed because loose",
  });
  expect(parsed.success).toBe(true);
  expect(parsed.success && Reflect.get(parsed.data, "extra")).toBe("allowed because loose");
});

test("HandoffStatusResponseSchema matches actual route body with required four-field reliability projection", () => {
  const body = {
    handoff_id: "h1",
    status: "completed",
    error_summary: null,
    branch_name: null,
    worker_id: null,
    started_at: "2026-01-01T00:00:00.000Z",
    resolved_at: "2026-01-01T00:01:00.000Z",
    latency_seconds: 60,
    reliability: {
      status: "complete",
      trustworthy: true,
      recommended_action: "accept",
      summary: "all good",
    },
  };
  expect(HandoffStatusResponseSchema.safeParse(body).success).toBe(true);
});

test("HandoffStatusResponseSchema is loose (accepts extra fields)", () => {
  const body = {
    handoff_id: "h1",
    status: "pending",
    error_summary: null,
    branch_name: null,
    worker_id: null,
    started_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    latency_seconds: null,
    reliability: {
      status: "complete",
      trustworthy: false,
      recommended_action: "wait",
      summary: "running",
    },
    extra: "allowed",
  };
  expect(HandoffStatusResponseSchema.safeParse(body).success).toBe(true);
});

test("HandoffStatusResponseSchema rejects missing reliability", () => {
  const body = {
    handoff_id: "h1",
    status: "completed",
    error_summary: null,
    branch_name: null,
    worker_id: null,
    started_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    latency_seconds: null,
  };
  expect(HandoffStatusResponseSchema.safeParse(body).success).toBe(false);
});

test("HandoffStatusResponseSchema preserves reliability response extensions", () => {
  const body = {
    handoff_id: "h1",
    status: "completed",
    error_summary: null,
    branch_name: null,
    worker_id: null,
    started_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    latency_seconds: null,
    reliability: {
      status: "complete",
      trustworthy: true,
      recommended_action: "accept",
      summary: "ok",
      terminal: true,
    },
  };
  const parsed = HandoffStatusResponseSchema.parse(body);
  expect(Reflect.get(parsed.reliability, "terminal")).toBe(true);
});

test("handoff reliability rejects unknown statuses and actions", () => {
  const reliability = HandoffStatusResponseSchema.shape.reliability;
  const valid = {
    status: "complete",
    trustworthy: true,
    recommended_action: "accept",
    summary: "ok",
  };
  expect(reliability.safeParse(valid).success).toBe(true);
  expect(reliability.safeParse({ ...valid, status: "bogus" }).success).toBe(false);
  expect(reliability.safeParse({ ...valid, recommended_action: "ship" }).success).toBe(false);
});

test("HandoffFailRequestSchema strips unknown request fields", () => {
  expect(HandoffFailRequestSchema.parse({ reason: "x", extra: true })).toEqual({ reason: "x" });
});
