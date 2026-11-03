import { describe, expect, test } from "bun:test";

import { TaskCooldowns } from "@src/tasks/cooldowns.js";

describe("TaskCooldowns", () => {
  test("add() keeps earlier agents on the same task", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 100);
    c.add("t1", "b", 200);
    expect(Object.fromEntries(c.get().get("t1") ?? [])).toEqual({ a: 100, b: 200 });
  });

  test("add() overwrites the expiry for the same task+agent", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 100);
    c.add("t1", "a", 500);
    expect(c.get().get("t1")?.get("a")).toBe(500);
  });

  test("prune(now) removes entries whose expiry equals now (inclusive boundary)", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 100);
    c.prune(100);
    expect(c.get().has("t1")).toBe(false);
  });

  test("prune(now) keeps entries that expire after now", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 101);
    c.prune(100);
    expect(c.get().get("t1")?.get("a")).toBe(101);
  });

  test("prune keeps a task while any agent is still cooling down", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 50);
    c.add("t1", "b", 150);
    c.prune(100);
    expect(c.get().has("t1")).toBe(true);
    expect([...(c.get().get("t1")?.keys() ?? [])]).toEqual(["b"]);
  });

  test("prune drops task entries that become empty and leaves other tasks alone", () => {
    const c = new TaskCooldowns();
    c.add("t1", "a", 50);
    c.add("t2", "a", 150);
    c.prune(100);
    expect([...c.get().keys()]).toEqual(["t2"]);
  });
});
