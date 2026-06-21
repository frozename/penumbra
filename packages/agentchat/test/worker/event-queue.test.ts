import { describe, expect, mock, test } from "bun:test";
import type { DispatchEventInput } from "@penumbra/core";
import { DispatchEventQueue } from "../../src/worker/event-queue.js";

const sample: DispatchEventInput = {
  handoff_id: "h-1",
  source: "worker",
  kind: "dispatch.start",
  ts: "2026-05-01T00:00:00.000Z",
};

describe("DispatchEventQueue", () => {
  test("flush drains queued events in batches", async () => {
    const send = mock(async (_events: DispatchEventInput[], _signal: AbortSignal) => {});
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 1000,
      maxBatch: 2,
      maxQueue: 10,
    });
    queue.enqueue(sample);
    queue.enqueue({ ...sample, kind: "proc.spawn" });
    queue.enqueue({ ...sample, kind: "dispatch.end" });

    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toHaveLength(2);
    expect(send.mock.calls[1]![0]).toHaveLength(1);
    await queue.stop();
  });

  test("drops oldest events beyond maxQueue", async () => {
    const send = mock(async () => {});
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 1000,
      maxBatch: 50,
      maxQueue: 2,
    });
    queue.enqueue(sample);
    queue.enqueue({ ...sample, kind: "proc.spawn" });
    queue.enqueue({ ...sample, kind: "dispatch.end" });

    expect(queue.droppedCount()).toBe(1);
    await queue.stop();
  });

  test("stop flushes and clears the interval", async () => {
    const send = mock(async () => {});
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 1000,
      maxBatch: 50,
      maxQueue: 10,
    });
    queue.enqueue(sample);

    await queue.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("stop waits for an in-flight flush and drains events enqueued during it", async () => {
    const firstSendStarted = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const send = mock(async (_events: DispatchEventInput[], _signal: AbortSignal) => {
      if (send.mock.calls.length === 1) {
        firstSendStarted.resolve();
        await releaseFirstSend.promise;
      }
    });
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 1000,
      maxBatch: 1,
      maxQueue: 10,
    });
    queue.enqueue(sample);

    void queue.flush();
    await firstSendStarted.promise;
    queue.enqueue({ ...sample, kind: "dispatch.end" });
    const stopPromise = queue.stop();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);

    releaseFirstSend.resolve();
    await stopPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.at(1)?.[0].at(0)?.kind).toBe("dispatch.end");
  });

  test("failed flush re-enqueues the batch so the next tick retries it", async () => {
    let unblock!: () => void;
    let attempt = 0;
    const send = mock((_events: DispatchEventInput[], _signal: AbortSignal) => {
      attempt++;
      if (attempt === 1) {
        return new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 10_000,
      maxBatch: 50,
      maxQueue: 10,
      sendTimeoutMs: 30,
    });

    queue.enqueue(sample);
    queue.enqueue({ ...sample, kind: "dispatch.end" });
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.sendFailureCount()).toBe(1);
    expect(queue.droppedCount()).toBe(0);

    await queue.flush();

    expect(send).toHaveBeenCalledTimes(2);
    const retriedBatch = send.mock.calls.at(1)?.[0] ?? [];
    expect(retriedBatch).toHaveLength(2);
    expect(retriedBatch.at(0)?.kind).toBe("dispatch.start");
    expect(retriedBatch.at(1)?.kind).toBe("dispatch.end");

    unblock();
    await queue.stop();
  });

  test("flush rejects-and-recovers when send hangs beyond send_timeout_ms", async () => {
    let capturedSignal: AbortSignal | undefined;
    let unblock!: () => void;
    let hangCount = 0;
    const send = mock((_events: DispatchEventInput[], signal: AbortSignal) => {
      hangCount++;
      if (hangCount === 1) {
        capturedSignal = signal;
        return new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 10_000,
      maxBatch: 50,
      maxQueue: 10,
      sendTimeoutMs: 30,
    });

    queue.enqueue(sample);
    await queue.flush();
    queue.enqueue({ ...sample, kind: "proc.spawn" });
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(capturedSignal?.aborted).toBe(true);
    unblock();
    await queue.stop();
  });
});
