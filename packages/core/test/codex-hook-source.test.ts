import { expect, test } from "bun:test";

import { OriginSchema, SourceSchema, T0EventInputSchema } from "@src/schemas/event.js";

test("Codex observations keep source separate from maestro origin", () => {
  expect(SourceSchema.safeParse("codex").success).toBe(true);
  expect(
    T0EventInputSchema.safeParse({
      ts: "2026-09-12T12:00:00.000Z",
      source: "codex",
      source_detail: "tool:apply_patch",
      project_id: "project-test",
      user_id: "codex",
      machine_id: "local",
      session_id: "opaque-root",
      event_type: "agent-tool-use",
      lane: "cli-subscription",
      provider: "openai",
      model: "gpt-5",
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: "tool-use-1",
      payload_json: {
        tool: "apply_patch",
        input: { patch: "*** Begin Patch" },
        tool_activity: "edit",
      },
      payload_summary: "apply_patch",
      origin: "maestro",
    }).success,
  ).toBe(true);
  expect(OriginSchema.safeParse("codex").success).toBe(false);
});
