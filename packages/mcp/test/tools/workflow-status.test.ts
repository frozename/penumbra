import { expect, mock, test } from "bun:test";
import { HandleStore } from "../../src/handle-store.js";
import { instrumentHandler } from "../../src/instrumentation.js";
import { DEFAULT_BUDGET, truncateToTokens } from "../../src/responses/budget.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";
import { workflowStatusHandler, workflowWaitHandler } from "../../src/tools/workflow-status.js";

test("workflow_status proxies workflow_run_id to daemon.workflowStatus", async () => {
  const daemon = { workflowStatus: mock(async () => ({ status: "running" })) };
  const handler = workflowStatusHandler(daemon as any);
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect(daemon.workflowStatus).toHaveBeenCalledWith({ workflow_run_id: "wfrun-1" });
  expect(JSON.parse(res.content[0].text)).toEqual({ status: "running" });
});

test("workflow_status MCP output contains no result field", async () => {
  const daemon = {
    workflowStatus: mock(async () => ({
      status: "completed",
      result_available: true,
      result_bytes: 100_123,
      error_bytes: 0,
    })),
  };
  const handler = workflowStatusHandler(daemon as any);
  const res = await handler({ workflow_run_id: "wfrun-1" });
  const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
  expect("result" in body).toBe(false);
});

test("workflow_status MCP output contains result_available + result_bytes", async () => {
  const daemon = {
    workflowStatus: mock(async () => ({
      status: "completed",
      result_available: true,
      result_bytes: 100_123,
      error_bytes: 0,
    })),
  };
  const handler = workflowStatusHandler(daemon as any);
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect(JSON.parse(res.content[0].text)).toMatchObject({
    status: "completed",
    result_available: true,
    result_bytes: 100_123,
  });
});

test("workflow_wait proxies workflow_run_id and timeout_ms to daemon.workflowWait", async () => {
  const daemon = { workflowWait: mock(async () => ({ status: "completed", started_at: 1 })) };
  const handler = workflowWaitHandler(daemon as any);
  await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
  expect(daemon.workflowWait).toHaveBeenCalledWith({
    workflow_run_id: "wfrun-1",
    timeout_ms: 1234,
  });
});

test("workflow_wait keeps under-budget result inline without handle", async () => {
  const result = { ok: true, note: "small payload" };
  const daemon = {
    workflowWait: mock(async () => ({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    })),
  };
  const store = new HandleStore();
  try {
    const handler = workflowWaitHandler(daemon as any, { handleStore: store });
    const res = await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(body.result).toEqual(result);
    expect(body.result_truncated).toBe(false);
    expect("result_handle_id" in body).toBe(false);
    expect("result_preview" in body).toBe(false);
  } finally {
    store.close();
  }
});

test("workflow_wait preserves daemon-truncated fields during mixed deploys", async () => {
  const daemon = {
    workflowWait: mock(async () => ({
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
    })),
  };
  const store = new HandleStore();
  try {
    const handler = workflowWaitHandler(daemon as any, { handleStore: store });
    const res = await handler({ workflow_run_id: "wfrun-legacy", timeout_ms: 1234 });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
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
  const daemon = {
    workflowWait: mock(async () => ({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_preview: "stale-preview",
      result_handle_id: "stale-handle",
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    })),
  };
  const handler = workflowWaitHandler(daemon as any);
  const res = await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
  const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
  expect(body.result).toEqual(result);
  expect(body.result_truncated).toBe(false);
  expect("result_preview" in body).toBe(false);
  expect("result_handle_id" in body).toBe(false);
});

test("workflow_wait spills oversized result/error into independent handles with string previews", async () => {
  const result = { payload: "🔥".repeat(DEFAULT_BUDGET * 6) };
  const error = { reason: "❌".repeat(DEFAULT_BUDGET * 6) };
  const daemon = {
    workflowWait: mock(async () => ({
      status: "failed",
      started_at: 1,
      finished_at: 2,
      result,
      error,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: Buffer.byteLength(JSON.stringify(error), "utf8"),
    })),
  };
  const store = new HandleStore();
  try {
    const wait = workflowWaitHandler(daemon as any, { handleStore: store });
    const read = readHandleHandler(store);
    const res = await wait({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;

    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(typeof body.result_preview).toBe("string");
    expect(body.result_preview).toBe(
      truncateToTokens(JSON.stringify(result).slice(0, DEFAULT_BUDGET * 10), DEFAULT_BUDGET).text,
    );
    expect(typeof body.result_handle_id).toBe("string");

    expect(body.error).toBeNull();
    expect(body.error_truncated).toBe(true);
    expect(typeof body.error_preview).toBe("string");
    expect(body.error_preview).toBe(
      truncateToTokens(JSON.stringify(error).slice(0, DEFAULT_BUDGET * 10), DEFAULT_BUDGET).text,
    );
    expect(typeof body.error_handle_id).toBe("string");
    expect(body.result_handle_id).not.toBe(body.error_handle_id);

    const resultRead = (await read({ handle_id: body.result_handle_id })) as any;
    const errorRead = (await read({ handle_id: body.error_handle_id })) as any;

    expect(resultRead.isError).toBeUndefined();
    expect(errorRead.isError).toBeUndefined();
    expect(JSON.parse(resultRead.content[0].text)).toEqual(result);
    expect(JSON.parse(errorRead.content[0].text)).toEqual(error);
  } finally {
    store.close();
  }
});

test("workflow_wait exposes result_handle_id after central response budgeting", async () => {
  const result = { payload: "x".repeat(DEFAULT_BUDGET * 6) };
  const daemon = {
    workflowWait: mock(async () => ({
      status: "completed",
      started_at: 1,
      finished_at: 2,
      result,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      error_bytes: 0,
    })),
  };
  const store = new HandleStore();
  try {
    const wait = workflowWaitHandler(daemon as any, { handleStore: store });
    const wrapped = instrumentHandler("workflow_wait", wait as any, {
      enabled: false,
      responseBudgetTokens: 64,
      handleStore: store,
    });
    const res: any = await wrapped({ workflow_run_id: "wfrun-1", timeout_ms: 1234 }, {});

    expect(isEnvelopeResult(res)).toBe(true);
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(typeof body.result_handle_id).toBe("string");

    const read: any = await readHandleHandler(store)({ handle_id: body.result_handle_id });
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(read.content[0].text)).toEqual(result);
  } finally {
    store.close();
  }
});
