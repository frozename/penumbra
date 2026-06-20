import { expect, test } from "bun:test";
import { chainWaitHandler, ChainWaitInputShape } from "../../src/tools/chain-wait.js";
import { DaemonHttpError } from "../../src/daemon-client.js";

test("ChainWaitInputShape requires conversation_id", () => {
  expect(() => (ChainWaitInputShape as any).conversation_id.parse(undefined)).toThrow();
  expect((ChainWaitInputShape as any).timeout_ms.parse(undefined)).toBe(60000);
});

test("chainWaitHandler polls until completed", async () => {
  let calls = 0;
  const daemon = {
    getLatestHandoff: async (conversation_id: string) => {
      calls++;
      if (calls === 1) return { handoff: { handoff_id: "h1", status: "dispatched" } };
      return { handoff: { handoff_id: "h1", status: "completed" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 1000 });

  expect(calls).toBe(2);
  expect(res.content[0].type).toBe("text");
  expect(res.content[0].text).toMatch(/^[●◑] chain_wait  /);
  expect(res.content[0].text).toContain('"status": "completed"');
  expect(res.content[0].text).toContain('"last_handoff_id": "h1"');
});

test("chainWaitHandler returns timeout if timeout_ms is reached", async () => {
  const daemon = {
    getLatestHandoff: async (conversation_id: string) => {
      return { handoff: { handoff_id: "h1", status: "dispatched" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 100 });

  expect(res.content[0].type).toBe("text");
  expect(res.content[0].text).toMatch(/^◑ chain_wait  /);
  expect(res.content[0].text).toContain('"status": "timeout"');
});

test("chainWaitHandler surfaces 5xx as a structured error, not a timeout", async () => {
  let calls = 0;
  const daemon = {
    getLatestHandoff: async (_conversation_id: string) => {
      calls++;
      throw new DaemonHttpError("daemon 503 service unavailable", 503, { code: "unavailable" });
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const startedAt = Date.now();
  const res = await handler({ conversation_id: "conv1", timeout_ms: 10_000 });
  const elapsed = Date.now() - startedAt;

  // Must fail fast, not wait near the timeout.
  expect(elapsed).toBeLessThan(2000);
  expect(calls).toBe(1);
  expect(res.content[0].type).toBe("text");
  const text = res.content[0].text;
  expect(text).toContain('"status": "error"');
  expect(text).toContain('"code": 503');
  expect(text).toContain("daemon 503 service unavailable");
  expect(text).not.toContain('"status": "timeout"');
});

test("chainWaitHandler surfaces 401 as a structured error, not a timeout", async () => {
  const daemon = {
    getLatestHandoff: async (_conversation_id: string) => {
      throw new DaemonHttpError("daemon 401 unauthorized", 401);
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const startedAt = Date.now();
  const res = await handler({ conversation_id: "conv1", timeout_ms: 10_000 });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(2000);
  const text = res.content[0].text;
  expect(text).toContain('"status": "error"');
  expect(text).toContain('"code": 401');
  expect(text).not.toContain('"status": "timeout"');
});

test("chainWaitHandler keeps polling on 404 until completed", async () => {
  let calls = 0;
  const daemon = {
    getLatestHandoff: async (_conversation_id: string) => {
      calls++;
      if (calls < 3) throw new DaemonHttpError("not found", 404);
      return { handoff: { handoff_id: "h-late", status: "completed" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 5000 });

  expect(calls).toBeGreaterThanOrEqual(3);
  const text = res.content[0].text;
  expect(text).toContain('"status": "completed"');
  expect(text).toContain('"last_handoff_id": "h-late"');
});

test("chainWaitHandler keeps polling on transient non-HTTP errors", async () => {
  let calls = 0;
  const daemon = {
    getLatestHandoff: async (_conversation_id: string) => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed: ECONNREFUSED");
      return { handoff: { handoff_id: "h1", status: "completed" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 5000 });

  expect(calls).toBe(2);
  const text = res.content[0].text;
  expect(text).toContain('"status": "completed"');
});
