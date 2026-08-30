import { describe, expect, it } from "bun:test";

import { DEFAULT_ID_KIND_MAP, withActingOnEnvelope } from "@src/tools/with-acting-on.js";

describe("withActingOnEnvelope", () => {
  it("adds acting_on for handoff_id and places it first", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve({ ok: true }));
    const result = await handler({ handoff_id: "h-1" });
    expect(result).toEqual({
      acting_on: { kind: "handoff", id: "h-1" },
      ok: true,
    });
    expect(Object.keys(result as Record<string, unknown>)[0]).toBe("acting_on");
  });

  it("maps conversation_id to conversation", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve({ ok: true }));
    const result = await handler({ conversation_id: "c-1" });
    expect(result).toEqual({
      acting_on: { kind: "conversation", id: "c-1" },
      ok: true,
    });
  });

  it("maps task_id to task", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve({ ok: true }));
    const result = await handler({ task_id: "t-1" });
    expect(result).toEqual({
      acting_on: { kind: "task", id: "t-1" },
      ok: true,
    });
  });

  it("maps plan_id to plan", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve({ ok: true }));
    const result = await handler({ plan_id: "p-1" });
    expect(result).toEqual({
      acting_on: { kind: "plan", id: "p-1" },
      ok: true,
    });
  });

  it("returns unchanged result when no recognized id field exists", async () => {
    const payload = { ok: true };
    const handler = withActingOnEnvelope(() => Promise.resolve(payload));
    const result = await handler({ foo: "bar" });
    expect(result).toBe(payload);
  });

  it("uses the first matching key from DEFAULT_ID_KIND_MAP", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve({ ok: true }));
    const result = await handler({ handoff_id: "h-1", conversation_id: "c-1" });
    expect(result).toEqual({
      acting_on: { kind: "handoff", id: "h-1" },
      ok: true,
    });
    expect(Object.keys(DEFAULT_ID_KIND_MAP)[0]).toBe("handoff_id");
  });

  it("passes through string results unchanged", async () => {
    const handler = withActingOnEnvelope(() => Promise.resolve("ok"));
    const result = await handler({ handoff_id: "h-1" });
    expect(result).toBe("ok");
  });

  it("passes through array results unchanged", async () => {
    const payload = ["ok"];
    const handler = withActingOnEnvelope(() => Promise.resolve(payload));
    const result = await handler({ handoff_id: "h-1" });
    expect(result).toBe(payload);
  });

  it("does not double-wrap if result already contains acting_on", async () => {
    const payload = {
      acting_on: { kind: "handoff", id: "existing" },
      ok: true,
    };
    const handler = withActingOnEnvelope(() => Promise.resolve(payload));
    const result = await handler({ handoff_id: "h-1" });
    expect(result).toBe(payload);
  });

  it("forwards the SDK's extra argument to the wrapped handler", async () => {
    const captured: unknown[] = [];
    const handler = withActingOnEnvelope((_input: unknown, extra: unknown) => {
      captured.push(extra);
      return { ok: true };
    });
    await handler({ handoff_id: "h-1" }, { _meta: { origin: "m" } });
    expect(captured).toEqual([{ _meta: { origin: "m" } }]);
  });

  it("rethrows handler errors", async () => {
    const err = new Error("boom");
    const handler = withActingOnEnvelope(() => {
      throw err;
    });
    let caught: unknown;
    try {
      await handler({ handoff_id: "h-1" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });

  it("skips Date, URL, and class instance results", async () => {
    const date = new Date("2026-05-11T00:00:00.000Z");
    const url = new URL("https://example.com");
    class Custom {
      constructor(public value: string) {}
    }
    const instance = new Custom("x");

    const dateResult = await withActingOnEnvelope(() => Promise.resolve(date))({
      handoff_id: "h-1",
    });
    const urlResult = await withActingOnEnvelope(() => Promise.resolve(url))({ handoff_id: "h-1" });
    const classResult = await withActingOnEnvelope(() => Promise.resolve(instance))({
      handoff_id: "h-1",
    });

    expect(dateResult).toBe(date);
    expect(urlResult).toBe(url);
    expect(classResult).toBe(instance);
  });
});
