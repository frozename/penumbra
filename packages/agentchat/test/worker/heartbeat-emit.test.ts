import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, mock, test } from "bun:test";

import { emitHeartbeat } from "../../src/worker/heartbeat-emit.js";

describe("emitHeartbeat", () => {
  test("records heartbeat.sent after a successful POST", async () => {
    const events: DispatchEventInput[] = [];
    const client = { postHeartbeat: mock(() => Promise.resolve()) };

    await emitHeartbeat({ client, workerId: "w-1", onEvent: (event) => events.push(event) });

    expect(client.postHeartbeat).toHaveBeenCalledWith("w-1", undefined);
    expect(events.some((event) => event.kind === "heartbeat.sent")).toBe(true);
  });

  test("passes an abort signal through to postHeartbeat when provided", async () => {
    const events: DispatchEventInput[] = [];
    const signals: AbortSignal[] = [];
    const client = {
      postHeartbeat: mock((_workerId: string, signal?: AbortSignal): Promise<void> => {
        if (signal) signals.push(signal);
        return Promise.resolve();
      }),
    };
    const controller = new AbortController();

    await emitHeartbeat({
      client,
      workerId: "w-1",
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
    expect(events.some((event) => event.kind === "heartbeat.sent")).toBe(true);
  });

  test("records heartbeat.sent and preserves failure when POST fails", async () => {
    const events: DispatchEventInput[] = [];
    const client = {
      postHeartbeat: mock((): Promise<void> => Promise.reject(new Error("boom"))),
    };

    let caught: unknown;
    try {
      await emitHeartbeat({ client, workerId: "w-1", onEvent: (event) => events.push(event) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(events.some((event) => event.kind === "heartbeat.sent")).toBe(true);
  });
});
