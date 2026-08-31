import { expect, test } from "bun:test";

import { HandoffTransitionBus, type LeftDispatchedEvent } from "@src/events/handoff-transitions.js";

const makeEvent = (id: string): LeftDispatchedEvent => ({
  kind: "left_dispatched",
  handoff_id: id,
  to_agent: "seat-a",
  to_status: "completed",
  ts: "2026-01-01T00:00:00Z",
});

test("subscribers receive left_dispatched events in order", () => {
  const bus = new HandoffTransitionBus();
  const seen: string[] = [];
  bus.subscribe((event) => seen.push(event.handoff_id));
  bus.emit(makeEvent("a"));
  bus.emit(makeEvent("b"));
  bus.emit(makeEvent("c"));
  expect(seen).toEqual(["a", "b", "c"]);
});

test("unsubscribe stops further delivery", () => {
  const bus = new HandoffTransitionBus();
  const seen: string[] = [];
  const off = bus.subscribe((event) => seen.push(event.handoff_id));
  bus.emit(makeEvent("a"));
  off();
  bus.emit(makeEvent("b"));
  expect(seen).toEqual(["a"]);
});

test("a throwing listener does not block the others", () => {
  const bus = new HandoffTransitionBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((event) => seen.push(event.handoff_id));
  expect(() => {
    bus.emit(makeEvent("x"));
  }).not.toThrow();
  expect(seen).toEqual(["x"]);
});
