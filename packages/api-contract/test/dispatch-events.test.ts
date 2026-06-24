import { describe, expect, it } from "bun:test";

import { DispatchEventsListResponseSchema } from "../src/dispatch-events.js";

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
});
