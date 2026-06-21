import { expect, test } from "bun:test";

import { PidRegistry } from "../../src/pid/registry.js";

test("register and iterate live PIDs", () => {
  const reg = new PidRegistry({ softCap: 2, hardCap: 4 });
  reg.register({ pid: process.pid, name: "self", startedAt: new Date() });
  const live = reg.live();
  expect(live.some((e) => e.pid === process.pid)).toBe(true);
});

test("reap drops entries whose PID is dead", () => {
  const reg = new PidRegistry({ softCap: 2, hardCap: 4 });
  // 999999 is almost certainly not a live PID.
  reg.register({ pid: 999999, name: "fake", startedAt: new Date() });
  const reaped = reg.reap();
  expect(reaped.length).toBe(1);
  expect(reg.live().some((e) => e.pid === 999999)).toBe(false);
});

test("over hardCap throws", () => {
  const reg = new PidRegistry({ softCap: 1, hardCap: 2 });
  reg.register({ pid: process.pid, name: "a", startedAt: new Date() });
  reg.register({ pid: process.pid, name: "b", startedAt: new Date() });
  expect(() => reg.register({ pid: process.pid, name: "c", startedAt: new Date() })).toThrow(
    /hardCap/,
  );
});

test("over softCap returns a warning but succeeds", () => {
  const reg = new PidRegistry({ softCap: 1, hardCap: 4 });
  reg.register({ pid: process.pid, name: "a", startedAt: new Date() });
  const warn = reg.register({ pid: process.pid, name: "b", startedAt: new Date() });
  expect(warn).toMatch(/softCap/);
});
