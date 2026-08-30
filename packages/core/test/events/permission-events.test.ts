import { describe, expect, test } from "bun:test";

import { type PermissionEvent, PermissionEventBus } from "@src/events/permission-events.js";

const sample = (id: string, kind: PermissionEvent["kind"]): PermissionEvent => ({
  kind,
  permission_id: id,
  ts: "2026-04-28T12:00:00.000Z",
  payload: { permission_id: id },
});

describe("PermissionEventBus", () => {
  test("subscribe receives subsequently-emitted events", () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: PermissionEvent[] = [];
    const off = bus.subscribe((evt) => seen.push(evt));
    bus.emit(sample("p-1", "permission.created"));
    bus.emit(sample("p-1", "permission.decided"));
    expect(seen.map((e) => e.kind)).toEqual(["permission.created", "permission.decided"]);
    off();
  });

  test("unsubscribe stops further deliveries", () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: PermissionEvent[] = [];
    const off = bus.subscribe((evt) => seen.push(evt));
    off();
    bus.emit(sample("p-1", "permission.created"));
    expect(seen).toEqual([]);
  });

  test("replaySince returns events strictly after the supplied seq", () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const a = bus.emit(sample("p-1", "permission.created"));
    const b = bus.emit(sample("p-2", "permission.created"));
    const c = bus.emit(sample("p-3", "permission.created"));
    expect(bus.replaySince(a.seq).map((e) => e.permission_id)).toEqual(["p-2", "p-3"]);
    expect(bus.replaySince(c.seq)).toEqual([]);
  });

  test("replaySince returns null when seq is older than the ring buffer", () => {
    const bus = new PermissionEventBus({ ringSize: 2 });
    const stale = bus.emit(sample("p-1", "permission.created"));
    bus.emit(sample("p-2", "permission.created"));
    bus.emit(sample("p-3", "permission.created"));
    bus.emit(sample("p-4", "permission.created"));
    expect(bus.replaySince(stale.seq)).toBeNull();
  });

  test("subscriber throwing does not block other subscribers", () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((evt) => seen.push(evt.permission_id));
    bus.emit(sample("p-1", "permission.created"));
    expect(seen).toEqual(["p-1"]);
  });
});
