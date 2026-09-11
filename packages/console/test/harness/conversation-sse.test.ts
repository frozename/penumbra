import { describe, expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { startHarness } from "../../e2e/harness/index";

const AUTH_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "text/event-stream",
});

async function openStream(
  baseUrl: string,
  token: string,
  conversationId: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await Bun.fetch(
    `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/stream`,
    { headers: AUTH_HEADERS(token) },
  );
  expect(res.status).toBe(200);
  expect(res.body).not.toBeNull();
  return res.body!.getReader();
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 5_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let accumulated = "";
  const result = await withDeadline(
    (async (): Promise<string> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.includes(needle)) return accumulated;
      }
      return accumulated;
    })(),
    timeoutMs,
    `SSE timeout waiting for "${needle}"`,
  );
  return result;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => {
    // ignore cancel errors during teardown
  });
}

describe("conversation SSE encoded ids", () => {
  test("literal percent, %2F, and slash ids remain distinct (no double-decode)", async () => {
    const h = await startHarness();
    try {
      const ids = ["c%1", "c/1", "c%2F1"];
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

      for (const id of ids) {
        const reader = await openStream(h.baseUrl, h.token, id);
        readers.push(reader);
      }

      for (const id of ids) {
        await h.waitForConversationSseClient(id);
      }

      for (const id of ids) {
        h.pushConversationEvent(id, { text: `evt-${id}` });
      }

      for (const [i, id] of ids.entries()) {
        const accumulated = await readUntil(readers[i]!, `"text":"evt-${id}"`);
        expect(accumulated).toContain(`"text":"evt-${id}"`);
      }

      for (const reader of readers) cancelReader(reader);
    } finally {
      await h.stop();
    }
  });
});

describe("conversation SSE reset", () => {
  test("reset ends all conversation SSE responses (reader gets EOF)", async () => {
    const h = await startHarness();
    try {
      const reader = await openStream(h.baseUrl, h.token, "c1");
      const { value: initial } = await reader.read();
      expect(new TextDecoder().decode(initial)).toContain(": ok");

      await h.waitForConversationSseClient("c1");

      h.reset();

      const { done } = await withDeadline(reader.read(), 5_000, "reader did not EOF after reset");
      expect(done).toBe(true);
    } finally {
      await h.stop();
    }
  });

  test("reset rejects pending conversation SSE waiters", async () => {
    const h = await startHarness();
    try {
      const waiter = h
        .waitForConversationSseClient("c1", { timeoutMs: 30_000 })
        .catch((e: unknown) => e as Error);

      h.reset();

      const result = await withDeadline(waiter, 1_000, "reset did not reject pending waiter");
      expect(result).not.toBe("timeout");
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("harness reset");
    } finally {
      await h.stop();
    }
  });
});

describe("conversation SSE stop", () => {
  test("stop closes active conversation reader with EOF and rejects pending waiter", async () => {
    const h = await startHarness();
    try {
      const reader = await openStream(h.baseUrl, h.token, "c1");
      await readUntil(reader, ": ok");
      await h.waitForConversationSseClient("c1");
      const waiter = h
        .waitForConversationSseClient("c-pending", { timeoutMs: 30_000 })
        .catch((e: unknown) => e as Error);
      const nextRead = reader.read();

      await h.stop();

      const { done } = await withDeadline(nextRead, 5_000, "reader did not EOF after stop");
      expect(done).toBe(true);
      const result = await withDeadline(waiter, 1_000, "stop did not reject pending waiter");
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("harness stopped");
    } finally {
      await h.stop();
    }
  });

  test("stop rejects conversation waiters even if server already stopped", async () => {
    const h = await startHarness();
    await h.stop();

    const waiter = h
      .waitForConversationSseClient("c1", { timeoutMs: 30_000 })
      .catch((e: unknown) => e as Error);

    await h.stop();

    const result = await withDeadline(waiter, 1_000, "stop did not reject pending waiter");
    expect(result).not.toBe("timeout");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("harness stopped");
  });
});

describe("conversation SSE fanout", () => {
  test("same-conversation two-client fanout: abort one, survivor still receives", async () => {
    const h = await startHarness();
    try {
      const reader1 = await openStream(h.baseUrl, h.token, "c1");
      const reader2 = await openStream(h.baseUrl, h.token, "c1");

      await readUntil(reader1, ": ok");
      await readUntil(reader2, ": ok");

      await h.waitForConversationSseClient("c1");

      h.pushConversationEvent("c1", { text: "both-get-this" });
      const [firstFrame, secondFrame] = await Promise.all([
        readUntil(reader1, '"text":"both-get-this"'),
        readUntil(reader2, '"text":"both-get-this"'),
      ]);
      expect(firstFrame).toContain('"text":"both-get-this"');
      expect(secondFrame).toContain('"text":"both-get-this"');

      await reader1.cancel();

      h.pushConversationEvent("c1", { text: "survivor-gets-this" });

      const accumulated = await readUntil(reader2, '"text":"survivor-gets-this"');
      expect(accumulated).toContain('"text":"survivor-gets-this"');

      cancelReader(reader2);
    } finally {
      await h.stop();
    }
  });
});

describe("conversation SSE reconnect after reset", () => {
  test("old close callback does not remove fresh stream after reset+reconnect", async () => {
    const h = await startHarness();
    try {
      const oldReader = await openStream(h.baseUrl, h.token, "c1");
      await readUntil(oldReader, ": ok");
      await h.waitForConversationSseClient("c1");

      h.reset();

      const { done } = await withDeadline(oldReader.read(), 5_000, "old reader did not EOF");
      expect(done).toBe(true);

      const newReader = await openStream(h.baseUrl, h.token, "c1");
      await readUntil(newReader, ": ok");
      await h.waitForConversationSseClient("c1");

      h.pushConversationEvent("c1", { text: "after-reconnect" });

      const accumulated = await readUntil(newReader, '"text":"after-reconnect"');
      expect(accumulated).toContain('"text":"after-reconnect"');

      cancelReader(newReader);
    } finally {
      await h.stop();
    }
  });
});

describe("conversation SSE timeout waiter cleanup", () => {
  test("timed-out waiter cleans up and subsequent connect works", async () => {
    const h = await startHarness();
    try {
      const shortWaiter = h
        .waitForConversationSseClient("c1", { timeoutMs: 50 })
        .catch((e: unknown) => e as Error);

      const err = await shortWaiter;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timed out");

      const reader = await openStream(h.baseUrl, h.token, "c1");
      await readUntil(reader, ": ok");

      await h.waitForConversationSseClient("c1");

      h.pushConversationEvent("c1", { text: "post-timeout" });
      const accumulated = await readUntil(reader, '"text":"post-timeout"');
      expect(accumulated).toContain('"text":"post-timeout"');

      cancelReader(reader);
    } finally {
      await h.stop();
    }
  });
});
