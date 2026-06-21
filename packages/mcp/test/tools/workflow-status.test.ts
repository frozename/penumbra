import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";
import type { EnvelopeResult } from "../../src/responses/envelope.js";

import { HandleStore } from "../../src/handle-store.js";
import { instrumentHandler } from "../../src/instrumentation.js";
import { DEFAULT_BUDGET, estimateTokens } from "../../src/responses/budget.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";
import { workflowStatusHandler, workflowWaitHandler } from "../../src/tools/workflow-status.js";
import { fakeDaemon } from "../helpers.js";

type WorkflowStatusFn = DaemonClient["workflowStatus"];
type WorkflowWaitFn = DaemonClient["workflowWait"];

interface TextEnvelope {
  content: { type: string; text: string }[];
}

function envelopeText(result: TextEnvelope): string {
  const block = result.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  return block.text;
}

function envelopeBody(result: TextEnvelope): Record<string, unknown> {
  return JSON.parse(envelopeText(result)) as Record<string, unknown>;
}

function asEnvelope(value: unknown): EnvelopeResult {
  if (!isEnvelopeResult(value)) {
    throw new Error("expected envelope result");
  }
  return value;
}

interface MaybeError {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function asMaybeError(value: unknown): MaybeError {
  return value as MaybeError;
}

test("workflow_status proxies workflow_run_id to daemon.workflowStatus", async () => {
  const workflowStatus = mock<WorkflowStatusFn>(() => Promise.resolve({ status: "running" }));
  const handler = workflowStatusHandler(fakeDaemon({ workflowStatus }));
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect(workflowStatus).toHaveBeenCalledWith({ workflow_run_id: "wfrun-1" });
  expect(envelopeBody(res)).toEqual({ status: "running" });
});

test("workflow_status MCP output contains no result field", async () => {
  const workflowStatus = mock<WorkflowStatusFn>(() =>
    Promise.resolve({
      status: "completed",
      result_available: true,
      result_bytes: 100_123,
      error_bytes: 0,
    }),
  );
  const handler = workflowStatusHandler(fakeDaemon({ workflowStatus }));
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect("result" in envelopeBody(res)).toBe(false);
});

test("workflow_status MCP output contains result_available + result_bytes", async () => {
  const workflowStatus = mock<WorkflowStatusFn>(() =>
    Promise.resolve({
      status: "completed",
      result_available: true,
      result_bytes: 100_123,
      error_bytes: 0,
    }),
  );
  const handler = workflowStatusHandler(fakeDaemon({ workflowStatus }));
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect(envelopeBody(res)).toMatchObject({
    status: "completed",
    result_available: true,
    result_bytes: 100_123,
  });
});

test("workflow_wait proxies workflow_run_id and timeout_ms to daemon.workflowWait", async () => {
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({ status: "completed", started_at: 1 }),
  );
  const handler = workflowWaitHandler(fakeDaemon({ workflowWait }));
  await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
  expect(workflowWait).toHaveBeenCalledWith({
    workflow_run_id: "wfrun-1",
    timeout_ms: 1234,
  });
});

test("workflow_wait keeps under-budget result inline without handle", async () => {
  const result = { ok: true, note: "small payload" };
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    }),
  );
  const store = new HandleStore();
  try {
    const handler = workflowWaitHandler(fakeDaemon({ workflowWait }), { handleStore: store });
    const res = await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
    const body = envelopeBody(res);
    expect(body.result).toEqual(result);
    expect(body.result_truncated).toBe(false);
    expect("result_handle_id" in body).toBe(false);
    expect("result_preview" in body).toBe(false);
  } finally {
    store.close();
  }
});

test("workflow_wait preserves daemon-truncated fields during mixed deploys", async () => {
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result: null,
      result_truncated: true,
      result_preview: '{"legacy":"preview"}',
      result_bytes: 10_000,
      error: null,
      error_truncated: true,
      error_preview: '{"legacy":"error"}',
      error_bytes: 8_000,
    }),
  );
  const store = new HandleStore();
  try {
    const handler = workflowWaitHandler(fakeDaemon({ workflowWait }), { handleStore: store });
    const res = await handler({ workflow_run_id: "wfrun-legacy", timeout_ms: 1234 });
    const body = envelopeBody(res);
    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(body.result_preview).toBe('{"legacy":"preview"}');
    expect(body.result_bytes).toBe(10_000);
    expect("result_handle_id" in body).toBe(false);
    expect(body.error).toBeNull();
    expect(body.error_truncated).toBe(true);
    expect(body.error_preview).toBe('{"legacy":"error"}');
    expect(body.error_bytes).toBe(8_000);
    expect("error_handle_id" in body).toBe(false);
  } finally {
    store.close();
  }
});

test("workflow_wait clears stale preview/handle fields when payload is under limit", async () => {
  const result = { ok: true };
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_preview: "stale-preview",
      result_handle_id: "stale-handle",
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    }),
  );
  const handler = workflowWaitHandler(fakeDaemon({ workflowWait }));
  const res = await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
  const body = envelopeBody(res);
  expect(body.result).toEqual(result);
  expect(body.result_truncated).toBe(false);
  expect("result_preview" in body).toBe(false);
  expect("result_handle_id" in body).toBe(false);
});

test("workflow_wait spills oversized result/error into independent handles with string previews", async () => {
  const result = { payload: "🔥".repeat(DEFAULT_BUDGET * 6) };
  const error = { reason: "❌".repeat(DEFAULT_BUDGET * 6) };
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "failed",
      started_at: 1,
      finished_at: 2,
      result,
      error,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: Buffer.byteLength(JSON.stringify(error), "utf8"),
    }),
  );
  const store = new HandleStore();
  try {
    const wait = workflowWaitHandler(fakeDaemon({ workflowWait }), { handleStore: store });
    const read = readHandleHandler(store);
    const res = await wait({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
    const body = envelopeBody(res);

    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(typeof body.result_preview).toBe("string");
    expect((body.result_preview as string).length).toBeGreaterThan(0);
    expect(typeof body.result_handle_id).toBe("string");

    expect(body.error).toBeNull();
    expect(body.error_truncated).toBe(true);
    expect(typeof body.error_preview).toBe("string");
    expect((body.error_preview as string).length).toBeGreaterThan(0);
    expect(typeof body.error_handle_id).toBe("string");
    expect(body.result_handle_id).not.toBe(body.error_handle_id);

    const resultRead = asMaybeError(await read({ handle_id: body.result_handle_id as string }));
    const errorRead = asMaybeError(await read({ handle_id: body.error_handle_id as string }));

    expect(resultRead.isError).toBeUndefined();
    expect(errorRead.isError).toBeUndefined();
    expect(JSON.parse(envelopeText(resultRead))).toEqual(result);
    expect(JSON.parse(envelopeText(errorRead))).toEqual(error);
  } finally {
    store.close();
  }
});

test("workflow_wait dual-spill envelope stays within DEFAULT_BUDGET and marks truncated", async () => {
  const result = { payload: "a".repeat(DEFAULT_BUDGET * 8) };
  const error = { reason: "b".repeat(DEFAULT_BUDGET * 8) };
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "failed",
      started_at: 1,
      finished_at: 2,
      result,
      error,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: Buffer.byteLength(JSON.stringify(error), "utf8"),
    }),
  );
  const store = new HandleStore();
  try {
    const wait = workflowWaitHandler(fakeDaemon({ workflowWait }), { handleStore: store });
    const res = await wait({ workflow_run_id: "wfrun-dual", timeout_ms: 1234 });

    expect(isEnvelopeResult(res)).toBe(true);
    const envelope = asEnvelope(res);
    const text = envelopeText(envelope);
    expect(estimateTokens(text)).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(envelope._meta.token_budget?.truncated).toBe(true);
    expect(envelope._meta.token_budget?.used).toBeLessThanOrEqual(DEFAULT_BUDGET);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.result_truncated).toBe(true);
    expect(body.error_truncated).toBe(true);
    expect(typeof body.result_handle_id).toBe("string");
    expect(typeof body.error_handle_id).toBe("string");
  } finally {
    store.close();
  }
});

test("workflow_wait exposes result_handle_id after central response budgeting", async () => {
  const result = { payload: "x".repeat(DEFAULT_BUDGET * 6) };
  const workflowWait = mock<WorkflowWaitFn>(() =>
    Promise.resolve({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    }),
  );
  const store = new HandleStore();
  try {
    const wait = workflowWaitHandler(fakeDaemon({ workflowWait }), { handleStore: store });
    const wrapped = instrumentHandler(
      "workflow_wait",
      (args: unknown): Promise<unknown> =>
        wait(args as { workflow_run_id: string; timeout_ms?: number }),
      {
        enabled: false,
        responseBudgetTokens: 64,
        handleStore: store,
      },
    );
    const res = await wrapped({ workflow_run_id: "wfrun-1", timeout_ms: 1234 }, {});

    expect(isEnvelopeResult(res)).toBe(true);
    const envelope = asEnvelope(res);
    const body = JSON.parse(envelopeText(envelope)) as Record<string, unknown>;
    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(typeof body.result_handle_id).toBe("string");

    const read = asMaybeError(
      await readHandleHandler(store)({ handle_id: body.result_handle_id as string }),
    );
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(envelopeText(read))).toEqual(result);
  } finally {
    store.close();
  }
});
