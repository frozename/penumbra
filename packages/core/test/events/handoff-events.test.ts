import type { HandoffRow } from "@penumbra/core";

import { HandoffEventBus } from "@penumbra/core";
import { expect, test } from "bun:test";

const makeRow = (id: string): HandoffRow => ({
  handoff_id: id,
  ts: "2026-01-01T00:00:00Z",
  project_id: null,
  conversation_id: "c",
  from_agent: "a",
  to_agent: "b",
  to_role: null,
  message: "",
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
  dispatch_attempts: 0,
  max_dispatch_attempts: 3,
});

test("subscribers receive emitted events in order", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe((row) => seen.push(row.handoff_id));
  bus.emit(makeRow("a"));
  bus.emit(makeRow("b"));
  bus.emit(makeRow("c"));
  expect(seen).toEqual(["a", "b", "c"]);
});

test("multiple subscribers each receive every event", () => {
  const bus = new HandoffEventBus();
  const a: string[] = [];
  const b: string[] = [];
  bus.subscribe((r) => a.push(r.handoff_id));
  bus.subscribe((r) => b.push(r.handoff_id));
  bus.emit(makeRow("x"));
  expect(a).toEqual(["x"]);
  expect(b).toEqual(["x"]);
});

test("unsubscribe stops further delivery", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  const off = bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit(makeRow("a"));
  off();
  bus.emit(makeRow("b"));
  expect(seen).toEqual(["a"]);
});

test("a subscriber that throws does not block other subscribers", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit(makeRow("x"));
  expect(seen).toEqual(["x"]);
});
