import { describe, expect, it } from "bun:test";

import {
  DispatchEventKindSchema,
  DispatchEventsListResponseSchema,
} from "../src/dispatch-events.js";

describe("dispatch event contract", () => {
  it("accepts legacy worktree_setup events from old workers and rows", () => {
    const parsed = DispatchEventsListResponseSchema.safeParse({
      events: [
        {
          handoff_id: "h-legacy",
          worker_id: "w-1",
          source: "worker",
          kind: "dispatch.worktree_setup",
          ts: "2026-06-12T12:00:00.000Z",
          meta: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts recorded agent heartbeat events", () => {
    const parsed = DispatchEventsListResponseSchema.safeParse({
      events: [
        {
          handoff_id: "h-heartbeat",
          worker_id: "w-1",
          source: "worker",
          kind: "agent.heartbeat",
          ts: "2026-06-12T12:00:00.000Z",
          meta: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("DispatchEventKindSchema accepts claim.reoffer and claim.provider_cap_refused", () => {
    expect(DispatchEventKindSchema.safeParse("claim.reoffer").success).toBe(true);
    expect(DispatchEventKindSchema.safeParse("claim.provider_cap_refused").success).toBe(true);
  });

  it("DispatchEventKindSchema accepts worker.recovery.drain_released", () => {
    expect(DispatchEventKindSchema.safeParse("worker.recovery.drain_released").success).toBe(true);
  });

  it("DispatchEventKindSchema accepts dream_p1_promotion_retry_exhausted", () => {
    expect(DispatchEventKindSchema.safeParse("dream_p1_promotion_retry_exhausted").success).toBe(
      true,
    );
  });

  it("DispatchEventKindSchema accepts agent.turn_retry (#322)", () => {
    expect(DispatchEventKindSchema.safeParse("agent.turn_retry").success).toBe(true);
  });

  it("DispatchEventKindSchema accepts the stdio-acp model selection kinds (#328)", () => {
    for (const kind of ["acp.model_selected", "acp.model_unavailable", "acp.model_select_failed"]) {
      expect(DispatchEventKindSchema.safeParse(kind).success).toBe(true);
    }
  });
});
