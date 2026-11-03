import { afterEach, expect, spyOn, test } from "bun:test";

import { SSE_HEADERS, sseCallbackStream, sseIteratorStream } from "@src/routes/_sse.js";

type IntervalCall = { cb: () => void; ms: number };

const SENTINEL_HANDLE = { keepalive: "sentinel" };

let intervalCalls: IntervalCall[] = [];
let clearedHandles: unknown[] = [];
let restoreTimers: (() => void) | null = null;

function installTimerMocks(): void {
  intervalCalls = [];
  clearedHandles = [];
  const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
    cb: (...args: unknown[]) => void,
    ms?: number,
  ) => {
    intervalCalls.push({ cb, ms: ms ?? 0 });
    return SENTINEL_HANDLE as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
    clearedHandles.push(handle);
  });
  restoreTimers = (): void => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  };
}

afterEach(() => {
  restoreTimers?.();
  restoreTimers = null;
});

class HandIterator<T> implements AsyncIterableIterator<T> {
  returnCalls = 0;
  returned: Promise<void>;
  private resolveReturned!: () => void;
  private pending: ((result: IteratorResult<T>) => void) | null = null;
  private queued: T[] = [];
  private ended = false;

  constructor() {
    this.returned = new Promise<void>((resolve) => {
      this.resolveReturned = resolve;
    });
  }

  push(value: T): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      const result: IteratorResult<T> = { value, done: false };
      resolve(result);
      return;
    }
    this.queued.push(value);
  }

  end(): void {
    this.ended = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.queued.length > 0) {
      const result: IteratorResult<T> = { value: this.queued.shift() as T, done: false };
      return Promise.resolve(result);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.pending = resolve;
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.returnCalls += 1;
    this.resolveReturned();
    this.ended = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined, done: true });
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

type ChunkReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read">;

async function readChunk(reader: ChunkReader): Promise<string> {
  const { value, done } = await reader.read();
  if (done) throw new Error("stream ended unexpectedly");
  return new TextDecoder().decode(value);
}

test("sseCallbackStream response carries SSE headers and status 200", () => {
  installTimerMocks();
  const res = sseCallbackStream({ start: () => null });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("connection")).toBe("keep-alive");
  expect(SSE_HEADERS).toEqual({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
});

test("sseCallbackStream starts once synchronously and streams written chunks in order", async () => {
  installTimerMocks();
  let startCalls = 0;
  let capturedWrite!: (chunk: string) => boolean;
  const res = sseCallbackStream({
    start: (write) => {
      startCalls += 1;
      capturedWrite = write;
      return (): void => undefined;
    },
  });
  expect(startCalls).toBe(1);

  expect(capturedWrite("data: one\n\n")).toBe(true);
  expect(capturedWrite("data: two\n\n")).toBe(true);

  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe("data: one\n\n");
  expect(await readChunk(reader)).toBe("data: two\n\n");
});

test("sseCallbackStream keepalive defaults to 15000ms and honors keepaliveMs", async () => {
  installTimerMocks();
  const res = sseCallbackStream({ start: () => null });
  expect(intervalCalls.length).toBe(1);
  expect(intervalCalls[0]!.ms).toBe(15_000);
  intervalCalls[0]!.cb();
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe(": keepalive\n\n");

  const res2 = sseCallbackStream({ keepaliveMs: 5, start: () => null });
  expect(intervalCalls.length).toBe(2);
  expect(intervalCalls[1]!.ms).toBe(5);
  await res2.body!.cancel();
});

test("sseCallbackStream cancel unsubscribes once, clears keepalive and disables write", async () => {
  installTimerMocks();
  let unsubscribeCalls = 0;
  let capturedWrite!: (chunk: string) => boolean;
  const res = sseCallbackStream({
    start: (write) => {
      capturedWrite = write;
      return (): void => {
        unsubscribeCalls += 1;
      };
    },
  });
  const reader = res.body!.getReader();
  await reader.cancel();
  expect(unsubscribeCalls).toBe(1);
  expect(clearedHandles).toContain(SENTINEL_HANDLE);
  expect(capturedWrite("data: late\n\n")).toBe(false);
});

test("sseCallbackStream cancel does not reject with null unsubscribe or throwing unsubscribe", async () => {
  installTimerMocks();
  const nullRes = sseCallbackStream({ start: () => null });
  await nullRes.body!.cancel();

  const throwingRes = sseCallbackStream({
    start: (): (() => void) => (): void => {
      throw new Error("unsubscribe exploded");
    },
  });
  await throwingRes.body!.cancel();
});

test("sseIteratorStream replays events then ok marker, then live events", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ a: number }>();
  const res = sseIteratorStream({
    subscribe: () => iter,
    replay: () => [{ a: 1 }, { a: 2 }],
  });
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe('data: {"a":1}\n\n');
  expect(await readChunk(reader)).toBe('data: {"a":2}\n\n');
  expect(await readChunk(reader)).toBe(": ok\n\n");

  iter.push({ a: 3 });
  expect(await readChunk(reader)).toBe('data: {"a":3}\n\n');
});

test("sseIteratorStream without replay emits ok marker first", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ a: number }>();
  const res = sseIteratorStream({ subscribe: () => iter });
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe(": ok\n\n");
});

test("sseIteratorStream custom format applies to replay and live events", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ id: string }>();
  const res = sseIteratorStream({
    subscribe: () => iter,
    replay: () => [{ id: "r1" }],
    format: (e) => `event: x\ndata: ${e.id}\n\n`,
  });
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe("event: x\ndata: r1\n\n");
  expect(await readChunk(reader)).toBe(": ok\n\n");
  iter.push({ id: "l1" });
  expect(await readChunk(reader)).toBe("event: x\ndata: l1\n\n");
});

test("sseIteratorStream keepalive defaults to 30000ms", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ a: number }>();
  const res = sseIteratorStream({ subscribe: () => iter });
  expect(intervalCalls.length).toBe(1);
  expect(intervalCalls[0]!.ms).toBe(30_000);
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe(": ok\n\n");
  intervalCalls[0]!.cb();
  expect(await readChunk(reader)).toBe(": keepalive\n\n");
});

test("sseIteratorStream cancel returns the iterator and clears keepalive", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ a: number }>();
  const res = sseIteratorStream({ subscribe: () => iter });
  const reader = res.body!.getReader();
  await reader.cancel();
  await iter.returned;
  expect(iter.returnCalls).toBe(1);
  expect(clearedHandles).toContain(SENTINEL_HANDLE);
});

test("sseIteratorStream natural exhaustion runs close via iterator return", async () => {
  installTimerMocks();
  const iter = new HandIterator<{ a: number }>();
  const res = sseIteratorStream({ subscribe: () => iter });
  const reader = res.body!.getReader();
  expect(await readChunk(reader)).toBe(": ok\n\n");
  iter.push({ a: 1 });
  expect(await readChunk(reader)).toBe('data: {"a":1}\n\n');
  iter.end();
  await iter.returned;
  expect(iter.returnCalls).toBe(1);
  expect(clearedHandles).toContain(SENTINEL_HANDLE);
});
