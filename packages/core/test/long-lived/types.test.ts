import {
  LongLivedAgentRowSchema,
  LongLivedPendingActionRowSchema,
  LongLivedTickRowSchema,
  WorkingMemorySchema,
} from "@penumbra/core/long-lived/types";
import { describe, expect, it } from "bun:test";

describe("long-lived types", () => {
  it("parses a minimal working memory blob", () => {
    const wm = WorkingMemorySchema.parse({
      version: 1,
      updated_at: Date.now(),
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    });
    expect(wm.version).toBe(1);
  });

  it("rejects working memory with wrong version", () => {
    expect(() =>
      WorkingMemorySchema.parse({
        version: 2,
        updated_at: 0,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
    ).toThrow();
  });

  it("accepts an agent row with all required fields", () => {
    const row = LongLivedAgentRowSchema.parse({
      id: "home-mgmt",
      display_name: "Home Management",
      status: "active",
      consecutive_failures: 0,
      circuit_breaker_threshold: 3,
      mcp_allowlist_json: "[]",
      approval_required_globs_json: "[]",
      cooldown_overrides_json: "{}",
      working_memory_json:
        '{"version":1,"updated_at":0,"pending_goals":[],"open_threads":[],"watches":[],"recent_decisions":[]}',
      standing_brief: "be helpful",
      created_at: 0,
      updated_at: 0,
    });
    expect(row.id).toBe("home-mgmt");
  });

  it("tick outcome is enumerated", () => {
    expect(() =>
      LongLivedTickRowSchema.parse({
        id: "t1",
        agent_id: "a",
        trigger_kind: "cron",
        started_at: 0,
        outcome: "banana",
      }),
    ).toThrow();
  });

  it("pending action status is enumerated", () => {
    expect(() =>
      LongLivedPendingActionRowSchema.parse({
        id: "p1",
        agent_id: "a",
        tick_id: "t1",
        action_kind: "ha:x",
        action_target: "foo",
        payload_json: "{}",
        status: "banana",
        expires_at: 0,
        created_at: 0,
      }),
    ).toThrow();
  });
});
