import { describe, expect, it, test } from "bun:test";
import {
  T0EventSchema,
  T0EventInputSchema,
  EventTypeSchema,
  SourceSchema,
  LaneSchema,
} from "../../src/schemas/event.js";

test("parses a complete T0 event", () => {
  const e = T0EventSchema.parse({
    event_id: "11111111-1111-4111-8111-111111111111",
    ts: "2026-04-23T12:00:00.000Z",
    ingest_ts: "2026-04-23T12:00:00.100Z",
    source: "mcp",
    source_detail: "claude-code",
    project_id: null,
    user_id: "22222222-2222-4222-8222-222222222222",
    machine_id: "33333333-3333-4333-8333-333333333333",
    session_id: "sess-1",
    event_type: "agent-tool-use",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { tool: "Read" },
    payload_summary: "Read src/x.ts",
    origin: "maestro",
  });
  expect(e.source).toBe("mcp");
  expect(e.payload_json).toEqual({ tool: "Read" });
  expect(e.origin).toBe("maestro");
});

test("T0EventInputSchema makes event_id + ingest_ts optional", () => {
  const parsed = T0EventInputSchema.parse({
    ts: "2026-04-23T12:00:00.000Z",
    source: "mcp",
    user_id: "u",
    machine_id: "m",
    event_type: "agent-prompt",
    lane: "cloud",
    payload_json: {},
  });
  expect(parsed.event_id).toBeUndefined();
});

test("rejects invalid source", () => {
  expect(() =>
    T0EventSchema.parse({
      event_id: "x",
      ts: "x",
      ingest_ts: "x",
      source: "oops",
      user_id: "u",
      machine_id: "m",
      event_type: "agent-prompt",
      lane: "cloud",
      payload_json: {},
      project_id: null,
      session_id: null,
      source_detail: null,
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_summary: null,
    }),
  ).toThrow();
});

test("EventTypeSchema accepts 'agent-handoff' and 'chain-terminated'", () => {
  expect(EventTypeSchema.safeParse("agent-handoff").success).toBe(true);
  expect(EventTypeSchema.safeParse("chain-terminated").success).toBe(true);
});

describe("EventTypeSchema permission audit types", () => {
  for (const event_type of [
    "permission-requested",
    "permission-decided",
    "permission-expired",
  ] as const) {
    it(`accepts ${event_type}`, () => {
      const input = {
        ts: "2026-04-28T12:00:00.000Z",
        source: "mcp",
        source_detail: "permission-audit",
        project_id: null,
        user_id: "u",
        machine_id: "m",
        session_id: null,
        event_type,
        lane: "unknown",
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: null,
        request_id: null,
        payload_json: { permission_id: "p-1" },
        payload_summary: "p-1",
      };
      expect(() => T0EventInputSchema.parse(input)).not.toThrow();
    });
  }
});

test("EventTypeSchema accepts agent-thought", () => {
  expect(EventTypeSchema.parse("agent-thought")).toBe("agent-thought");
});

test("T0EventInputSchema accepts an agent-thought event", () => {
  const parsed = T0EventInputSchema.parse({
    ts: "2026-04-29T00:00:00Z",
    source: "agentchat",
    user_id: "u",
    machine_id: "m",
    event_type: "agent-thought",
    lane: "cloud",
    payload_json: { text: "thinking…" },
  });
  expect(parsed.event_type).toBe("agent-thought");
});

test("EventTypeSchema accepts usage-update", () => {
  expect(EventTypeSchema.parse("usage-update")).toBe("usage-update");
});

test("EventTypeSchema accepts rate-limit-snapshot", () => {
  expect(EventTypeSchema.parse("rate-limit-snapshot")).toBe("rate-limit-snapshot");
});

test("EventTypeSchema accepts reconciler.verdict", () => {
  expect(EventTypeSchema.parse("reconciler.verdict")).toBe("reconciler.verdict");
});

test("EventTypeSchema accepts reconciler.pr.swept", () => {
  expect(EventTypeSchema.parse("reconciler.pr.swept")).toBe("reconciler.pr.swept");
});

test("EventTypeSchema accepts task.gh_state_pulled", () => {
  expect(EventTypeSchema.parse("task.gh_state_pulled")).toBe("task.gh_state_pulled");
});

test("EventTypeSchema accepts gh_issue_comment", () => {
  expect(EventTypeSchema.parse("gh_issue_comment")).toBe("gh_issue_comment");
});

test("T0EventInputSchema accepts a usage-update event", () => {
  const parsed = T0EventInputSchema.parse({
    ts: "2026-04-29T00:05:00Z",
    source: "mcp",
    user_id: "u",
    machine_id: "m",
    event_type: "usage-update",
    lane: "unknown",
    payload_json: { provider: "openai" },
  });
  expect(parsed.event_type).toBe("usage-update");
});

describe("EventTypeSchema", () => {
  it("accepts provider-capacity-error", () => {
    expect(() => EventTypeSchema.parse("provider-capacity-error")).not.toThrow();
  });
});

test("SourceSchema accepts daemon", () => {
  expect(SourceSchema.parse("daemon")).toBe("daemon");
});

test("LaneSchema accepts system", () => {
  expect(LaneSchema.parse("system")).toBe("system");
});

describe("EventTypeSchema task-draft lifecycle", () => {
  const variants = [
    "task_draft",
    "task_draft_refining",
    "task_draft_promoted",
    "task_draft_stale",
    "task_draft_duplicate",
    "task_draft_escalation",
  ] as const;
  for (const v of variants) {
    it(`accepts ${v}`, () => {
      expect(EventTypeSchema.parse(v)).toBe(v);
    });
  }
});
