import { describe, expect, it } from "bun:test";

import { renderDiscordEvent } from "../../src/worker/discord-events.js";

describe("renderDiscordEvent", () => {
  it("renders dispatch end without prompt by default", () => {
    const payload = renderDiscordEvent(
      {
        kind: "dispatch_end",
        project_id: "penumbra",
        handoff_id: "h-1",
        conversation_id: "c-1",
        agent: "codex",
        status: "completed",
        latency_seconds: 12,
        prompt: "private prompt",
      },
      { promptPolicy: "never" },
    );
    const json = JSON.stringify(payload);
    expect(json).toContain("dispatch completed");
    expect(json).toContain("penumbra");
    expect(json).not.toContain("private prompt");
  });

  it("renders permission request without raw tool input", () => {
    const payload = renderDiscordEvent(
      {
        kind: "permission_requested",
        project_id: "penumbra",
        permission_id: "p-1",
        handoff_id: "h-1",
        conversation_id: "c-1",
        agent: "claude",
        tool_name: "terminal.create",
        ttl_at: "2026-05-01T12:00:00.000Z",
      },
      { promptPolicy: "always" },
    );
    const json = JSON.stringify(payload);
    expect(json).toContain("permission requested");
    expect(json).toContain("terminal.create");
    expect(json).not.toContain("raw_input");
  });

  it("renders watchdog failures as red high-signal events", () => {
    const payload = renderDiscordEvent(
      {
        kind: "watchdog_failure",
        project_id: "penumbra",
        handoff_id: "h-1",
        conversation_id: "c-1",
        agent: "gemini",
        worker_id: "worker-primary",
        error_summary: "worker timeout",
      },
      { promptPolicy: "never" },
    );
    expect(payload.embeds[0]?.color).toBe(0xcc0000);
    expect(JSON.stringify(payload)).toContain("worker-primary");
  });
});
