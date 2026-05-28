/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and sqlite row mocks intentionally use loose shapes */
import { expect, test } from "bun:test";
import { HandoffEventBus } from "@penumbra/core";

test("subscribers receive emitted events in order", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe((row) => seen.push(row.handoff_id));
  bus.emit({ handoff_id: "a" } as any);
  bus.emit({ handoff_id: "b" } as any);
  bus.emit({ handoff_id: "c" } as any);
  expect(seen).toEqual(["a", "b", "c"]);
});

test("multiple subscribers each receive every event", () => {
  const bus = new HandoffEventBus();
  const a: string[] = [];
  const b: string[] = [];
  bus.subscribe((r) => a.push(r.handoff_id));
  bus.subscribe((r) => b.push(r.handoff_id));
  bus.emit({ handoff_id: "x" } as any);
  expect(a).toEqual(["x"]);
  expect(b).toEqual(["x"]);
});

test("unsubscribe stops further delivery", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  const off = bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit({ handoff_id: "a" } as any);
  off();
  bus.emit({ handoff_id: "b" } as any);
  expect(seen).toEqual(["a"]);
});

test("a subscriber that throws does not block other subscribers", () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit({ handoff_id: "x" } as any);
  expect(seen).toEqual(["x"]);
});
