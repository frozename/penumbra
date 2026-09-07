import { describe, expect, test } from "bun:test";

import {
  ApproveHandoffRequestSchema,
  ApproveHandoffResponseSchema,
  ApprovePermissionRequestSchema,
  CreatePermissionRequestSchema,
  HealthResponseSchema,
  PermissionRequestRowSchema,
  RegistrarEventSchema,
  RegistrarEventsListResponseSchema,
  RegistrarListResponseSchema,
  WorkspaceSchema,
} from "../src/index.js";

describe("ApproveHandoffRequestSchema", () => {
  test("ApproveHandoffRequestSchema rejects {redirect_to:'x', reject:true}", () => {
    expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: "x", reject: true }).success).toBe(
      false,
    );
    expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: "x" }).success).toBe(true);
    expect(ApproveHandoffRequestSchema.safeParse({ reject: true, reason: "no" }).success).toBe(
      true,
    );
  });
});

describe("ApproveHandoffResponseSchema", () => {
  test("ApproveHandoffResponseSchema requires handoff_id and status and is loose", () => {
    expect(
      ApproveHandoffResponseSchema.safeParse({ handoff_id: "h", status: "approved", extra: 1 })
        .success,
    ).toBe(true);
    expect(ApproveHandoffResponseSchema.safeParse({ handoff_id: "h" }).success).toBe(false);
    expect(
      ApproveHandoffResponseSchema.safeParse({ handoff_id: "h", status: "bogus" }).success,
    ).toBe(false);
  });
});

describe("HealthResponseSchema", () => {
  test("HealthResponseSchema keeps version and reviewBacklog", () => {
    const parsed = HealthResponseSchema.parse({
      status: "ok",
      version: "0.0.0",
      reviewBacklog: {
        open_lanes_count: 1,
        open_boundary_lanes_count: 0,
        oldest_open_lane_age_ms: 5,
      },
      extra: 1,
    });
    expect(parsed.version).toBe("0.0.0");
    expect(parsed.reviewBacklog?.open_lanes_count).toBe(1);
    expect(HealthResponseSchema.safeParse({ status: "down" }).success).toBe(false);
  });
});

describe("WorkspaceSchema", () => {
  test("WorkspaceSchema accepts all-null fields and is loose", () => {
    expect(
      WorkspaceSchema.safeParse({ projectId: null, branch: null, dirty: null, extra: true })
        .success,
    ).toBe(true);
    expect(WorkspaceSchema.safeParse({ projectId: "p" }).success).toBe(false);
  });
});

describe("RegistrarEventsListResponseSchema", () => {
  test("RegistrarEventsListResponseSchema parses {events:[RegistrarEvent]}", () => {
    const storedEvent = {
      event_id: 1,
      registrar_id: "registrar-1",
      phase_no: null,
      state: null,
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "operator",
      body: "status update",
      created_at: 1_700_000_000,
      kind: "progress",
    };
    expect(RegistrarEventSchema.safeParse(storedEvent).success).toBe(true);
    expect(RegistrarEventsListResponseSchema.safeParse({ events: [storedEvent] }).success).toBe(
      true,
    );
  });
});

describe("RegistrarListResponseSchema", () => {
  test("RegistrarListResponseSchema accepts entries[].rollup as RegistrarRollup and absent", () => {
    const entry = {
      registrar_id: "r",
      slug: "s",
      title: "t",
      home_project: "p",
      source_doc_path: null,
      status: "draft",
      created_at: 1,
      updated_at: 1,
    };
    const withRollup = RegistrarListResponseSchema.parse({
      entries: [{ ...entry, rollup: { open_blockers: 1, open_follow_ups: 0 } }],
    });
    expect(withRollup.entries[0]?.rollup).toEqual({ open_blockers: 1, open_follow_ups: 0 });
    expect(RegistrarListResponseSchema.safeParse({ entries: [entry] }).success).toBe(true);
    expect(
      RegistrarListResponseSchema.safeParse({
        entries: [{ ...entry, rollup: { open_blockers: -1, open_follow_ups: 0 } }],
      }).success,
    ).toBe(false);
  });
});

describe("ApprovePermissionRequestSchema", () => {
  test("ApprovePermissionRequestSchema rejects decision:'maybe'", () => {
    expect(ApprovePermissionRequestSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(
      ApprovePermissionRequestSchema.safeParse({ decision: "approve", remember: "this_dispatch" })
        .success,
    ).toBe(true);
  });
});

describe("PermissionRequestRowSchema", () => {
  test("PermissionRequestRowSchema round-trips decided_at null", () => {
    const row = {
      permission_id: "p1",
      parent_handoff_id: "h1",
      conversation_id: "c1",
      agent_name: "a",
      tool_name: "t",
      raw_input_json: "{}",
      status: "pending" as const,
      remember_scope: null,
      decision_reason: null,
      decided_by: null,
      ttl_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      decided_at: null,
    };
    expect(PermissionRequestRowSchema.parse(row)).toEqual(row);
  });
});

describe("CreatePermissionRequestSchema", () => {
  test("CreatePermissionRequestSchema requires permission_id", () => {
    expect(CreatePermissionRequestSchema.safeParse({}).success).toBe(false);
  });
});
