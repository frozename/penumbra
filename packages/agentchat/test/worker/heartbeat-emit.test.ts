import { describe, expect, mock, test } from "bun:test";
import { emitHeartbeat } from "../../src/worker/heartbeat-emit.js";

describe("emitHeartbeat", () => {
  test("records heartbeat.sent after a successful POST", async () => {
    const events: any[] = [];
    const client = { postHeartbeat: mock(async () => {}) };

    await emitHeartbeat({ client, workerId: "w-1", onEvent: (event) => events.push(event) });

    expect(client.postHeartbeat).toHaveBeenCalledWith("w-1", undefined);
    expect(events.some((event) => event.kind === "heartbeat.sent")).toBe(true);
  });

  test("passes an abort signal through to postHeartbeat when provided", async () => {
    const events: any[] = [];
    const signals: AbortSignal[] = [];
    const client = {
      postHeartbeat: mock(async (_workerId: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
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
    const events: any[] = [];
    const client = {
      postHeartbeat: mock(async () => {
        throw new Error("boom");
      }),
    };

    await expect(
      emitHeartbeat({ client, workerId: "w-1", onEvent: (event) => events.push(event) }),
    ).rejects.toThrow("boom");
    expect(events.some((event) => event.kind === "heartbeat.sent")).toBe(true);
  });
});
