import { describe, expect, test } from "bun:test";

import { type TaskEvent, TaskEventBus } from "@src/tasks/event-bus.js";

function taskEvent(id: string): TaskEvent {
  return { task_id: id, at: 0, kind: "filed", actor: null, payload: null };
}

const EMPTY = Symbol("empty");

function nextOrEmpty(
  it: AsyncIterableIterator<TaskEvent>,
): Promise<IteratorResult<TaskEvent> | typeof EMPTY> {
  return Promise.race([it.next(), Promise.resolve(EMPTY)]);
}

describe("TaskEventBus delivery semantics", () => {
  test("predicate filters events per subscriber", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe((e) => e.task_id === "a");
    bus.publish(taskEvent("b"));
    bus.publish(taskEvent("a"));
    expect(await nextOrEmpty(sub)).toEqual({ value: taskEvent("a"), done: false });
    expect(await nextOrEmpty(sub)).toBe(EMPTY);
    await sub.return?.();
  });

  test("an awaiting next() receives the event directly and it is not queued again", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe();
    const p = sub.next();
    const x = taskEvent("x");
    bus.publish(x);
    expect(await p).toEqual({ value: x, done: false });
    expect(await nextOrEmpty(sub)).toBe(EMPTY);
    await sub.return?.();
  });

  test("publish fans out to every subscriber even after resolving one waiter", async () => {
    const bus = new TaskEventBus();
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    const p1 = s1.next();
    const x = taskEvent("x");
    bus.publish(x);
    expect(await p1).toEqual({ value: x, done: false });
    expect(await nextOrEmpty(s2)).toEqual({ value: x, done: false });
    await s1.return?.();
    await s2.return?.();
  });

  test("return() resolves a pending next() with done", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe();
    const p = sub.next();
    await sub.return?.();
    expect(await Promise.race([p, Promise.resolve(EMPTY)])).toEqual({
      value: undefined,
      done: true,
    });
  });

  test("after return(), queued events are discarded and next() is done", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe();
    bus.publish(taskEvent("x"));
    await sub.return?.();
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
    bus.publish(taskEvent("y"));
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
  });

  test("throw() with an Error rejects with that same Error and closes", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe();
    if (!sub.throw) throw new Error("iterator lacks throw");
    const err = new Error("boom");
    const caught: unknown = await sub.throw(err).catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(await nextOrEmpty(sub)).toEqual({ value: undefined, done: true });
  });

  test("throw() wraps non-Error values in an Error", async () => {
    const bus = new TaskEventBus();
    const sub = bus.subscribe();
    if (!sub.throw) throw new Error("iterator lacks throw");
    const caught: unknown = await sub.throw("boom").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : String(caught)).toBe("boom");
  });

  test("warns at most once per subscriber when evicting", async () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const bus = new TaskEventBus({ maxQueueLength: 1 });
      const sub = bus.subscribe();
      for (let i = 0; i < 4; i++) {
        bus.publish(taskEvent(`t-${String(i)}`));
      }
      expect(warnings.filter((w) => w.includes("TaskEventBus")).length).toBe(1);
      await sub.return?.();
    } finally {
      console.warn = original;
    }
  });

  test("default queue bound is 1000 events", async () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const bus = new TaskEventBus();
      const sub = bus.subscribe();
      for (let i = 0; i <= 1000; i++) {
        bus.publish(taskEvent(`t-${String(i)}`));
      }
      const r = await nextOrEmpty(sub);
      if (r === EMPTY || r.done === true) throw new Error("expected an event");
      expect(r.value.task_id).toBe("t-1");
      await sub.return?.();
    } finally {
      console.warn = original;
    }
  });
});
