import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { chainWaitHandler, ChainWaitInputShape } from "@src/tools/chain-wait.js";

import { fakeDaemon } from "../helpers.js";

type GetLatestHandoffFn = DaemonClient["getLatestHandoff"];

function textOf(res: { content: { text?: unknown }[] }): string {
  const text = res.content[0].text;
  if (typeof text !== "string") throw new Error("expected text content");
  return text;
}

test("ChainWaitInputShape requires conversation_id", () => {
  expect(() => ChainWaitInputShape.conversation_id.parse(undefined)).toThrow();
  expect(() => ChainWaitInputShape.conversation_id.parse("")).toThrow();
  expect(ChainWaitInputShape.timeout_ms.parse(undefined)).toBe(60000);
});

test("chainWaitHandler polls until completed", async () => {
  let calls = 0;
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) => {
    calls++;
    if (calls === 1)
      return Promise.resolve({
        handoff: { handoff_id: "h1", status: "dispatched", conversation_id: "conv1" },
      });
    return Promise.resolve({
      handoff: {
        handoff_id: "h1",
        status: "completed",
        conversation_id: "conv1",
        branch_name: "feat/x-2",
      },
    });
  };
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 1000 });

  expect(calls).toBe(2);
  expect(res.content[0].type).toBe("text");
  const text = textOf(res);
  expect(text).toMatch(/^[●◑] chain_wait {2}/);
  expect(text).toContain('"status": "completed"');
  expect(text).toContain('"last_handoff_id": "h1"');
  expect(text).toContain('"branch_name": "feat/x-2"');
});

test("chainWaitHandler returns timeout if timeout_ms is reached", async () => {
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) =>
    Promise.resolve({
      handoff: { handoff_id: "h1", status: "dispatched", conversation_id: "conv1" },
    });
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 100 });

  expect(res.content[0].type).toBe("text");
  const text = textOf(res);
  expect(text).toMatch(/^◑ chain_wait {2}/);
  expect(text).toContain('"status": "timeout"');
});

test("chainWaitHandler surfaces 5xx as a structured error, not a timeout", async () => {
  let calls = 0;
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) => {
    calls++;
    return Promise.reject(
      new DaemonHttpError("daemon 503 service unavailable", 503, { code: "unavailable" }),
    );
  };
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const startedAt = Date.now();
  const res = await handler({ conversation_id: "conv1", timeout_ms: 10_000 });
  const elapsed = Date.now() - startedAt;

  // Must fail fast, not wait near the timeout.
  expect(elapsed).toBeLessThan(2000);
  expect(calls).toBe(1);
  expect(res.content[0].type).toBe("text");
  const text = textOf(res);
  expect(text).toContain('"status": "error"');
  expect(text).toContain('"code": 503');
  expect(text).toContain("daemon 503 service unavailable");
  expect(text).not.toContain('"status": "timeout"');
});

test("chainWaitHandler surfaces 401 as a structured error, not a timeout", async () => {
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) =>
    Promise.reject(new DaemonHttpError("daemon 401 unauthorized", 401));
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const startedAt = Date.now();
  const res = await handler({ conversation_id: "conv1", timeout_ms: 10_000 });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(2000);
  const text = textOf(res);
  expect(text).toContain('"status": "error"');
  expect(text).toContain('"code": 401');
  expect(text).not.toContain('"status": "timeout"');
});

test("chainWaitHandler surfaces permanent 4xx as a structured error, not a timeout", async () => {
  let calls = 0;
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) => {
    calls++;
    return Promise.reject(new DaemonHttpError("daemon 400 missing_param", 400));
  };
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const startedAt = Date.now();
  const res = await handler({ conversation_id: "conv1", timeout_ms: 10_000 });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(2000);
  expect(calls).toBe(1);
  const text = textOf(res);
  expect(text).toContain('"status": "error"');
  expect(text).toContain('"code": 400');
  expect(text).not.toContain('"status": "timeout"');
});

test("chainWaitHandler keeps polling on 404 until completed", async () => {
  let calls = 0;
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) => {
    calls++;
    if (calls < 3) return Promise.reject(new DaemonHttpError("not found", 404));
    return Promise.resolve({
      handoff: { handoff_id: "h-late", status: "completed", conversation_id: "conv1" },
    });
  };
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 5000 });

  expect(calls).toBeGreaterThanOrEqual(3);
  const text = textOf(res);
  expect(text).toContain('"status": "completed"');
  expect(text).toContain('"last_handoff_id": "h-late"');
});

test("chainWaitHandler keeps polling on transient non-HTTP errors", async () => {
  let calls = 0;
  const getLatestHandoff: GetLatestHandoffFn = (_conversation_id: string) => {
    calls++;
    if (calls === 1) return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
    return Promise.resolve({
      handoff: { handoff_id: "h1", status: "completed", conversation_id: "conv1" },
    });
  };
  const daemon = fakeDaemon({ getLatestHandoff });

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 5000 });

  expect(calls).toBe(2);
  const text = textOf(res);
  expect(text).toContain('"status": "completed"');
});
