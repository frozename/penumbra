import { afterEach, describe, expect, it, vi } from "bun:test";

import { createDispatchAbortSignal } from "@src/adapters/dispatch-abort.js";

/**
 * #342: pins createDispatchAbortSignal semantics — passthrough for
 * non-positive timeouts, parent-abort propagation, first-abort-wins,
 * timeout firing exactly once, the forced AbortError name, and cleanup
 * detaching both the parent listener and the timer. All timing runs on
 * fake timers.
 */

const makeErr = vi.fn((ms: number) => new Error(`timed out after ${String(ms)}ms`));

afterEach(() => {
  vi.useRealTimers();
  makeErr.mockClear();
});

describe("createDispatchAbortSignal", () => {
  it("passes through the parent signal when timeoutMs is 0 or negative", () => {
    vi.useFakeTimers();
    try {
      for (const timeoutMs of [0, -5]) {
        const parent = new AbortController().signal;
        const handle = createDispatchAbortSignal(parent, timeoutMs, makeErr);
        expect(handle.signal).toBe(parent);
        expect(handle.timeoutError).toBeNull();
        expect(() => {
          handle.cleanup();
          handle.cleanup();
        }).not.toThrow();
        vi.advanceTimersByTime(60_000);
        expect(makeErr).not.toHaveBeenCalled();
        expect(handle.signal.aborted).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("passthrough handle aborts with the parent because it is the same signal", () => {
    const controller = new AbortController();
    const handle = createDispatchAbortSignal(controller.signal, 0, makeErr);
    controller.abort("r");
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe("r");
  });

  it("returns a fresh unaborted signal when timeoutMs > 0", () => {
    const parent = new AbortController().signal;
    const handle = createDispatchAbortSignal(parent, 1000, makeErr);
    try {
      expect(handle.signal).not.toBe(parent);
      expect(handle.signal.aborted).toBe(false);
      expect(handle.timeoutError).toBeNull();
    } finally {
      handle.cleanup();
    }
  });

  it("propagates the parent abort reason and cancels the timeout on cleanup", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const handle = createDispatchAbortSignal(controller.signal, 1000, makeErr);
      const reason = new Error("user cancel");
      controller.abort(reason);
      expect(handle.signal.aborted).toBe(true);
      expect(handle.signal.reason).toBe(reason);
      expect(handle.timeoutError).toBeNull();
      handle.cleanup();
      vi.advanceTimersByTime(1000);
      expect(makeErr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts synchronously when the parent is already aborted", () => {
    const controller = new AbortController();
    controller.abort("pre");
    const handle = createDispatchAbortSignal(controller.signal, 1000, makeErr);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe("pre");
    handle.cleanup();
  });

  it("fires the timeout exactly once at exactly timeoutMs", () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController().signal;
      const handle = createDispatchAbortSignal(parent, 250, makeErr);
      vi.advanceTimersByTime(249);
      expect(handle.signal.aborted).toBe(false);
      expect(makeErr).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(makeErr).toHaveBeenCalledTimes(1);
      expect(makeErr).toHaveBeenCalledWith(250);
      expect(handle.signal.aborted).toBe(true);
      const produced = makeErr.mock.results[0]?.value as Error;
      expect(handle.signal.reason).toBe(produced);
      expect(handle.timeoutError).toBe(produced);
      handle.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces the timeout error name to AbortError while preserving the message", () => {
    vi.useFakeTimers();
    try {
      const namedErr = vi.fn(
        (ms: number): Error =>
          Object.assign(new Error(`boom after ${String(ms)}ms`), { name: "TimeoutError" }),
      );
      const parent = new AbortController().signal;
      const handle = createDispatchAbortSignal(parent, 100, namedErr);
      vi.advanceTimersByTime(100);
      expect(handle.timeoutError).not.toBeNull();
      expect(handle.timeoutError?.name).toBe("AbortError");
      expect(handle.timeoutError?.message).toBe("boom after 100ms");
      handle.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout error as the reason when the parent aborts later", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const handle = createDispatchAbortSignal(controller.signal, 250, makeErr);
      vi.advanceTimersByTime(250);
      const timeoutErr = handle.timeoutError;
      expect(timeoutErr).not.toBeNull();
      controller.abort(new Error("late"));
      expect(handle.signal.reason).toBe(timeoutErr);
      handle.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup detaches the parent listener and clears the timer", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const handle = createDispatchAbortSignal(controller.signal, 1000, makeErr);
      handle.cleanup();
      controller.abort("x");
      expect(handle.signal.aborted).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(makeErr).not.toHaveBeenCalled();
      expect(handle.timeoutError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
