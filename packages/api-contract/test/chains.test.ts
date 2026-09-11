import { expect, test } from "bun:test";

import {
  ChainAgentsResponseSchema,
  ChainMessageEventSchema,
  ChainMessagesResponseSchema,
  ChainSendMessageRequestSchema,
  ChainStartRequestSchema,
  DispatchRefineRequestSchema,
  DispatchRefineResponseSchema,
} from "../src/chains.js";

const minimal = {
  initial_agent: "codex",
  message: "do it",
};

const allSupported = {
  ...minimal,
  task_name: "fix-thing",
  branch_type: "feature-x",
  conversation_id: "c-1",
  project_id: "abcdef0123456789:packages/x",
  max_hops: 5,
  trust_mode: "all" as const,
  use_worktree: true,
  parent_handoff_id: "h-1",
  dispatch_kind: "workflow" as const,
  workflow_run_id: "w-1",
  long_lived_agent_id: "lla-1",
  long_lived_tick_id: "t-1",
  branch_base: "main",
  open_pr_on_review: false,
  task_type: "implement_substantial" as const,
  task_class: "STANDARD" as const,
  tool_free: false,
  isolated_install: true,
};

test("ChainStartRequestSchema strips unknown keys and preserves all supported fields", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    ...allSupported,
    unknown_probe: "should be stripped",
  });

  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  expect(Object.prototype.hasOwnProperty.call(parsed.data, "unknown_probe")).toBe(false);
  expect(parsed.data).toEqual(allSupported);
});

test("ChainStartRequestSchema rejects invalid max_hops", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, max_hops: 0 }).success).toBe(false);
  expect(ChainStartRequestSchema.safeParse({ ...minimal, max_hops: -1 }).success).toBe(false);
  expect(ChainStartRequestSchema.safeParse({ ...minimal, max_hops: 1.5 }).success).toBe(false);
  expect(ChainStartRequestSchema.safeParse({ ...minimal, max_hops: "5" }).success).toBe(false);
});

test("ChainStartRequestSchema rejects invalid task_type", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, task_type: "bogus" }).success).toBe(false);
});

test("ChainStartRequestSchema rejects invalid task_class", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, task_class: "OTHER" }).success).toBe(
    false,
  );
});

test("ChainStartRequestSchema rejects traversal project_id", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, project_id: "../etc" }).success).toBe(
    false,
  );
  expect(ChainStartRequestSchema.safeParse({ ...minimal, project_id: "/etc/passwd" }).success).toBe(
    false,
  );
});

test("ChainStartRequestSchema rejects non-boolean isolated_install", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, isolated_install: "true" }).success).toBe(
    false,
  );
});

test("ChainStartRequestSchema rejects empty branch_base", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, branch_base: "" }).success).toBe(false);
});

test("ChainStartRequestSchema rejects invalid trust_mode", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, trust_mode: "none" }).success).toBe(false);
});

test("ChainStartRequestSchema preprocesses use_worktree 1/0 and accepts null/undefined", () => {
  const one = ChainStartRequestSchema.safeParse({ ...minimal, use_worktree: 1 });
  expect(one.success).toBe(true);
  if (one.success) expect(one.data.use_worktree).toBe(true);

  const zero = ChainStartRequestSchema.safeParse({ ...minimal, use_worktree: 0 });
  expect(zero.success).toBe(true);
  if (zero.success) expect(zero.data.use_worktree).toBe(false);

  const nulled = ChainStartRequestSchema.safeParse({ ...minimal, use_worktree: null });
  expect(nulled.success).toBe(true);
  if (nulled.success) {
    expect(Object.prototype.hasOwnProperty.call(nulled.data, "use_worktree")).toBe(true);
    expect(nulled.data.use_worktree).toBeNull();
  }

  const undef = ChainStartRequestSchema.safeParse({ ...minimal, use_worktree: undefined });
  expect(undef.success).toBe(true);
  if (undef.success) {
    expect(undef.data.use_worktree).toBeUndefined();
  }
});

test("ChainStartRequestSchema preserves explicit true and false tool_free", () => {
  const trueParsed = ChainStartRequestSchema.safeParse({ ...minimal, tool_free: true });
  expect(trueParsed.success).toBe(true);
  if (trueParsed.success) expect(trueParsed.data.tool_free).toBe(true);

  const falseParsed = ChainStartRequestSchema.safeParse({ ...minimal, tool_free: false });
  expect(falseParsed.success).toBe(true);
  if (falseParsed.success) expect(falseParsed.data.tool_free).toBe(false);
});

test("ChainStartRequestSchema leaves absent tool_free absent", () => {
  const parsed = ChainStartRequestSchema.safeParse({ ...minimal });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(Object.prototype.hasOwnProperty.call(parsed.data, "tool_free")).toBe(false);
    expect(parsed.data.tool_free).toBeUndefined();
  }
});

test("ChainStartRequestSchema rejects non-boolean tool_free", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, tool_free: "true" }).success).toBe(false);
});

test("ChainStartRequestSchema accepts branch_type and reserves 'agent'", () => {
  expect(ChainStartRequestSchema.safeParse({ ...minimal, branch_type: "feature-x" }).success).toBe(
    true,
  );
  expect(ChainStartRequestSchema.safeParse({ ...minimal, branch_type: "agent" }).success).toBe(
    false,
  );
});

test("ChainMessagesResponseSchema parses a message event with a null user_id", () => {
  const parsed = ChainMessagesResponseSchema.safeParse({
    events: [
      {
        event_id: "evt-1",
        ts: "2026-09-11T00:00:00Z",
        event_type: "agent.thought",
        source: "claude",
        source_detail: null,
        user_id: null,
        payload: { text: "hello" },
      },
    ],
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.events).toHaveLength(1);
  expect(parsed.data.events[0]!.event_id).toBe("evt-1");
  expect(parsed.data.events[0]!.user_id).toBeNull();
  expect(parsed.data.events[0]!.source_detail).toBeNull();
});

test("ChainMessageEventSchema accepts extra keys via loose", () => {
  const parsed = ChainMessageEventSchema.safeParse({
    event_id: "evt-2",
    ts: "2026-09-11T00:00:01Z",
    event_type: "dispatch.start",
    source: "daemon",
    source_detail: "worker-1",
    user_id: "u-1",
    payload: {},
    extra_field: "allowed",
  });
  expect(parsed.success).toBe(true);
});

test("ChainAgentsResponseSchema parses {agents:[{name}]}", () => {
  const parsed = ChainAgentsResponseSchema.safeParse({
    agents: [{ name: "claude" }, { name: "gemini" }],
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.agents).toHaveLength(2);
  expect(parsed.data.agents[0]!.name).toBe("claude");
});

test("ChainSendMessageRequestSchema requires non-empty content", () => {
  expect(ChainSendMessageRequestSchema.safeParse({ content: "hello" }).success).toBe(true);
  expect(ChainSendMessageRequestSchema.safeParse({ content: "" }).success).toBe(false);
  expect(ChainSendMessageRequestSchema.safeParse({}).success).toBe(false);
});

test("DispatchRefineRequestSchema requires a message string", () => {
  expect(DispatchRefineRequestSchema.safeParse({ message: "do stuff" }).success).toBe(true);
  expect(DispatchRefineRequestSchema.safeParse({ message: "" }).success).toBe(false);
  expect(DispatchRefineRequestSchema.safeParse({}).success).toBe(false);
});

test("DispatchRefineResponseSchema parses {refined}", () => {
  const parsed = DispatchRefineResponseSchema.safeParse({ refined: "refined prompt" });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.refined).toBe("refined prompt");
});
