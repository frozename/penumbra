import { describe, expect, test } from "bun:test";

import { type DispatchEvent, DispatchEventBus } from "@src/dispatch/event-bus.js";
import { type TaskEvent, TaskEventBus } from "@src/tasks/event-bus.js";

function taskEvent(id: number): TaskEvent {
  return {
    task_id: `task-${String(id)}`,
    at: id,
    kind: "filed",
    actor: null,
    payload: null,
  };
}

function dispatchEvent(id: number): DispatchEvent {
  return {
    handoff_id: `handoff-${String(id)}`,
    worker_id: null,
    source: "daemon",
    kind: "dispatch.start",
    ts: `2026-07-06T00:00:0${String(id)}.000Z`,
    meta: null,
  };
}

describe("in-memory event buses", () => {
  test("TaskEventBus bounds idle subscriber queues and evicts oldest events", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const bus = new TaskEventBus({ maxQueueLength: 3 });
      const subscriber = bus.subscribe();

      for (let id = 0; id < 5; id += 1) {
        bus.publish(taskEvent(id));
      }

      const drained: TaskEvent[] = [];
      for (let i = 0; i < 3; i += 1) {
        const next = await subscriber.next();
        expect(next.done).toBe(false);
        if (next.done) throw new Error("subscriber ended unexpectedly");
        drained.push(next.value);
      }

      expect(drained.map((event) => event.task_id)).toEqual(["task-2", "task-3", "task-4"]);
      expect(warnings.some((warning) => warning.includes("TaskEventBus"))).toBe(true);
      await subscriber.return?.();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("DispatchEventBus bounds idle subscriber queues and evicts oldest events", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const bus = new DispatchEventBus({ maxQueueLength: 3 });
      const subscriber = bus.subscribe();

      for (let id = 0; id < 5; id += 1) {
        bus.publish(dispatchEvent(id));
      }

      const drained: DispatchEvent[] = [];
      for (let i = 0; i < 3; i += 1) {
        const next = await subscriber.next();
        expect(next.done).toBe(false);
        if (next.done) throw new Error("subscriber ended unexpectedly");
        drained.push(next.value);
      }

      expect(drained.map((event) => event.handoff_id)).toEqual([
        "handoff-2",
        "handoff-3",
        "handoff-4",
      ]);
      expect(warnings.some((warning) => warning.includes("DispatchEventBus"))).toBe(true);
      await subscriber.return?.();
    } finally {
      console.warn = originalWarn;
    }
  });
});
