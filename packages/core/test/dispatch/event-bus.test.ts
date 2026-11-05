import { describe, expect, test } from "bun:test";

import { type DispatchEvent, DispatchEventBus } from "@src/dispatch/event-bus.js";

function dispatchEvent(id: string): DispatchEvent {
  return {
    handoff_id: id,
    worker_id: null,
    source: "daemon",
    kind: "dispatch.start",
    ts: "2026-07-06T00:00:00.000Z",
    meta: null,
  };
}

const EMPTY = Symbol("empty");

function nextOrEmpty(
  it: AsyncIterableIterator<DispatchEvent>,
): Promise<IteratorResult<DispatchEvent> | typeof EMPTY> {
  return Promise.race([it.next(), Promise.resolve(EMPTY)]);
}

describe("DispatchEventBus delivery semantics", () => {
  test("a subscriber's predicate filters events", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe((e) => e.handoff_id === "a");
    bus.publish(dispatchEvent("b"));
    bus.publish(dispatchEvent("a"));
    expect(await nextOrEmpty(sub)).toEqual({
      value: dispatchEvent("a"),
      done: false,
    });
    expect(await nextOrEmpty(sub)).toBe(EMPTY);
    await sub.return?.();
  });

  test("subscribe() with no predicate receives every event", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    bus.publish(dispatchEvent("a"));
    bus.publish(dispatchEvent("b"));
    expect(await nextOrEmpty(sub)).toEqual({
      value: dispatchEvent("a"),
      done: false,
    });
    expect(await nextOrEmpty(sub)).toEqual({
      value: dispatchEvent("b"),
      done: false,
    });
    expect(await nextOrEmpty(sub)).toBe(EMPTY);
    await sub.return?.();
  });

  test("a pending next() created before publish resolves with that event", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    const p = sub.next();
    bus.publish(dispatchEvent("x"));
    expect(await p).toEqual({ value: dispatchEvent("x"), done: false });
    expect(await nextOrEmpty(sub)).toBe(EMPTY);
    await sub.return?.();
  });

  test("publish fans out to every subscriber even after resolving one waiter", async () => {
    const bus = new DispatchEventBus();
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    const p1 = s1.next();
    bus.publish(dispatchEvent("x"));
    expect(await p1).toEqual({ value: dispatchEvent("x"), done: false });
    expect(await nextOrEmpty(s2)).toEqual({
      value: dispatchEvent("x"),
      done: false,
    });
    await s1.return?.();
    await s2.return?.();
  });

  test("return() resolves an already-pending next() with done", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    const p = sub.next();
    await sub.return?.();
    expect(await Promise.race([p, Promise.resolve(EMPTY)])).toEqual({
      value: undefined,
      done: true,
    });
  });

  test("return() discards queued events", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    bus.publish(dispatchEvent("x"));
    bus.publish(dispatchEvent("y"));
    await sub.return?.();
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
  });

  test("after return(), later publish calls are not delivered", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    await sub.return?.();
    bus.publish(dispatchEvent("z"));
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
  });

  test("throw(err) with an Error rejects with that same instance", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    if (!sub.throw) throw new Error("iterator lacks throw");
    const err = new Error("boom");
    const rejected: unknown = await sub.throw(err).catch((e: unknown) => e);
    expect(rejected).toBe(err);
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
  });

  test('throw("boom") with a non-Error rejects with an Error', async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    if (!sub.throw) throw new Error("iterator lacks throw");
    const rejected: unknown = await sub.throw("boom").catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected instanceof Error ? rejected.message : String(rejected)).toBe("boom");
  });

  test("warns at most once per subscriber", async () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const bus = new DispatchEventBus({ maxQueueLength: 1 });
      const sub = bus.subscribe();
      for (let i = 0; i < 4; i++) {
        bus.publish(dispatchEvent(`e-${String(i)}`));
      }
      expect(warnings.filter((w) => w.includes("DispatchEventBus")).length).toBe(1);
      await sub.return?.();
      const sub2 = bus.subscribe();
      for (let i = 0; i < 4; i++) {
        bus.publish(dispatchEvent(`f-${String(i)}`));
      }
      expect(warnings.filter((w) => w.includes("DispatchEventBus")).length).toBe(2);
      await sub2.return?.();
    } finally {
      console.warn = original;
    }
  });

  test("the default queue bound is 1000", async () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const bus = new DispatchEventBus();
      const sub = bus.subscribe();
      for (let i = 0; i <= 1000; i++) {
        bus.publish(dispatchEvent(`e${String(i)}`));
      }
      const r = await nextOrEmpty(sub);
      if (r === EMPTY || r.done === true) throw new Error("expected an event");
      expect(r.value.handoff_id).toBe("e1");
      await sub.return?.();
    } finally {
      console.warn = original;
    }
  });

  test("[Symbol.asyncIterator]() returns the same iterator object", async () => {
    const bus = new DispatchEventBus();
    const sub = bus.subscribe();
    expect(sub[Symbol.asyncIterator]()).toBe(sub);
    await sub.return?.();
  });
});
