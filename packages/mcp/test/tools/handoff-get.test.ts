import { expect, test } from "bun:test";
import { z } from "zod";

import type { DaemonClient, HandoffShape } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import { handoffGetHandler, HandoffGetInputShape } from "../../src/tools/handoff-get.js";
import { fakeDaemon } from "../helpers.js";

type GetHandoffFn = DaemonClient["getHandoff"];

test("HandoffGetInputShape requires handoff_id", () => {
  const schema = z.object(HandoffGetInputShape);
  expect(() => schema.parse({})).toThrow();
  expect(schema.parse({ handoff_id: "h1" }).handoff_id).toBe("h1");
});

test("handoffGetHandler calls daemon.getHandoff and formats output", async () => {
  const handoffFixture: HandoffShape = {
    handoff_id: "h1",
    status: "completed",
    error_message: null,
    worker_id: "w1",
    resolved_at: "2026-04-26T20:00:00Z",
    resolution_reason: "done",
    ts: "2026-04-26T19:00:00Z",
    conversation_id: "c1",
    from_agent: "user",
    to_agent: "agent",
  };
  const getHandoff: GetHandoffFn = (handoff_id) => {
    expect(handoff_id).toBe("h1");
    return Promise.resolve({ handoff: handoffFixture });
  };
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const res = await handler({ handoff_id: "h1" });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(block.text).toMatch(/^[◌◐●◑] handoff {2}/);
  expect(block.text).toContain('"handoff_id": "h1"');
});

test("handoffGetHandler maps daemon 404s to a structured not_found payload", async () => {
  const err = new DaemonHttpError("daemon /handoffs/missing: HTTP 404", 404, {
    error: { code: "not_found", message: "handoff missing not found" },
  });
  const getHandoff: GetHandoffFn = () => Promise.reject(err);
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const res = await handler({ handoff_id: "missing" });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toMatch(/^◑ handoff {2}/);
  expect(block.text).toContain('"code": "not_found"');
});

test("handoffGetHandler surfaces error_message for failed handoffs", async () => {
  const handoffFixture: HandoffShape = {
    handoff_id: "h2",
    status: "failed",
    error_message: "something went wrong",
    worker_id: "w1",
    resolved_at: "2026-04-26T20:00:00Z",
    resolution_reason: null,
    ts: "2026-04-26T19:00:00Z",
    conversation_id: "c1",
    from_agent: "user",
    to_agent: "agent",
  };
  const getHandoff: GetHandoffFn = () => Promise.resolve({ handoff: handoffFixture });
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const res = await handler({ handoff_id: "h2" });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toMatch(/^◑ handoff {2}/);
  expect(block.text).toContain('"error_message": "something went wrong"');
});

async function expectRejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("handoffGetHandler rethrows non-404 daemon errors", async () => {
  const getHandoff: GetHandoffFn = () => Promise.reject(new Error("daemon /handoffs/h1: HTTP 500"));
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const err = await expectRejects(handler({ handoff_id: "h1" }));
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("HTTP 500");
});

test("handoffGetHandler rethrows DaemonHttpError 500s instead of masking them as not_found", async () => {
  const err = new DaemonHttpError("test", 500, "oops");
  const getHandoff: GetHandoffFn = () => Promise.reject(err);
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const caught = await expectRejects(handler({ handoff_id: "h1" }));
  expect(caught).toBe(err);
});

test("handoff_get with compact:true omits message and truncates resolution_reason", async () => {
  const longMessage = "x".repeat(5000);
  const longReason =
    "a".repeat(500) + "MIDDLE-MARKER" + "b".repeat(500) + "END-MARKER" + "c".repeat(500);
  const getHandoff: GetHandoffFn = () =>
    Promise.resolve({
      handoff: {
        handoff_id: "h-1",
        ts: "2026-04-28T00:00:00Z",
        status: "failed",
        conversation_id: "c1",
        from_agent: "user",
        to_agent: "codex-mini",
        message: longMessage,
        resolution_reason: longReason,
      },
    });
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const res = await handler({ handoff_id: "h-1", compact: true });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toMatch(/^[◌◐●◑] handoff {2}/);
  expect(block.text).not.toContain('"message":');
  expect(block.text).toContain("truncated");
  expect(block.text).not.toContain("MIDDLE-MARKER");
});

test("handoff_get without compact preserves backward-compat shape", async () => {
  const longMessage = "x".repeat(5000);
  const getHandoff: GetHandoffFn = () =>
    Promise.resolve({
      handoff: {
        handoff_id: "h-1",
        conversation_id: "c1",
        message: longMessage,
        resolution_reason: "short",
        status: "pending",
      },
    });
  const handler = handoffGetHandler(fakeDaemon({ getHandoff }));
  const res = await handler({ handoff_id: "h-1" });
  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.text).toMatch(/^[◌◐●◑] handoff {2}/);
  expect(block.text).toContain(longMessage);
  expect(block.text).toContain('"resolution_reason": "short"');
});
