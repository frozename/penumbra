import { describe, expect, it } from "bun:test";

import { DaemonHttpError } from "@src/daemon-client.js";
import { HandleStore } from "@src/handle-store.js";
import { DEFAULT_BUDGET, estimateTokens } from "@src/responses/budget.js";
import { errorContent, makeFsEnvelopeResult, toErrorContent } from "@src/tools/fs-envelope.js";

function errorPayload(input: unknown): { code: unknown; message: unknown } {
  const result = toErrorContent(input);
  const first = result.content[0];
  if (!first?.text) throw new Error("missing content[0].text");
  const parsed: unknown = JSON.parse(first.text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("expected JSON object");
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.error !== "object" || envelope.error === null) {
    throw new Error("expected error object");
  }
  const error = envelope.error as Record<string, unknown>;
  return { code: error.code, message: error.message };
}

describe("errorContent", () => {
  it("builds the compact error JSON with isError", () => {
    expect(errorContent("c", "m")).toEqual({
      content: [{ type: "text", text: '{"error":{"code":"c","message":"m"}}' }],
      isError: true,
    });
  });
});

describe("toErrorContent", () => {
  it("maps a bodiless DaemonHttpError 404 to not_found", () => {
    const err = new DaemonHttpError("daemon 404", 404);
    expect(errorPayload(err)).toEqual({ code: "not_found", message: "daemon 404" });
  });

  it("maps a bodiless DaemonHttpError 503 to internal_error", () => {
    const err = new DaemonHttpError("daemon 503", 503);
    expect(errorPayload(err).code).toBe("internal_error");
  });

  it("prefers a string body code over the 404 default", () => {
    const err = new DaemonHttpError("daemon 404", 404, { error: { code: "worktree_gone" } });
    const payload = errorPayload(err);
    expect(payload.code).toBe("worktree_gone");
    expect(payload.message).toBe(err.message);
  });

  it("prefers a string body message over err.message", () => {
    const err = new DaemonHttpError("daemon 500", 500, {
      error: { code: "x", message: "from body" },
    });
    const payload = errorPayload(err);
    expect(payload.message).toBe("from body");
    expect(payload.message).not.toBe(err.message);
  });

  it("ignores non-string body code and message fields", () => {
    const err = new DaemonHttpError("daemon 404", 404, { error: { code: 42, message: 7 } });
    const payload = errorPayload(err);
    expect(payload.code).toBe("not_found");
    expect(payload.message).toBe(err.message);
  });

  it("ignores a non-object body", () => {
    const err = new DaemonHttpError("daemon 500", 500, "oops");
    const payload = errorPayload(err);
    expect(payload.code).toBe("internal_error");
    expect(payload.message).toBe(err.message);
  });

  it("treats a null error body field as absent", () => {
    const err = new DaemonHttpError("daemon 404", 404, { error: null });
    expect(errorPayload(err).code).toBe("not_found");
  });

  it("maps a plain Error to internal_error with its message", () => {
    expect(errorPayload(new Error("boom"))).toEqual({ code: "internal_error", message: "boom" });
  });

  it("maps a thrown non-Error to internal_error with unknown error", () => {
    const result = toErrorContent("str");
    expect(result.isError).toBe(true);
    expect(errorPayload("str")).toEqual({ code: "internal_error", message: "unknown error" });
  });
});

describe("makeFsEnvelopeResult", () => {
  it("returns small payloads verbatim with token_budget meta", () => {
    const raw = '{"a":1}';
    const result = makeFsEnvelopeResult(raw);
    const first = result.content[0];
    if (!first?.text) throw new Error("missing content[0].text");
    expect(first.text).toBe(raw);
    expect(result._meta.token_budget).toEqual({
      used: estimateTokens(raw),
      limit: DEFAULT_BUDGET,
      truncated: false,
    });
  });

  it("treats exactly-budget-sized payloads as not truncated", () => {
    const raw = "x".repeat(DEFAULT_BUDGET * 4);
    const result = makeFsEnvelopeResult(raw);
    expect(result._meta.token_budget?.truncated).toBe(false);
    const first = result.content[0];
    if (!first?.text) throw new Error("missing content[0].text");
    expect(first.text).toBe(raw);
  });

  it("truncates one token past the budget", () => {
    const raw = "x".repeat(DEFAULT_BUDGET * 4 + 1);
    const result = makeFsEnvelopeResult(raw);
    expect(result._meta.token_budget?.truncated).toBe(true);
  });

  it("does not use the handle store when the payload fits the budget", () => {
    const store = new HandleStore();
    try {
      const result = makeFsEnvelopeResult('{"a":1}', { handleStore: store });
      expect("handle_id" in result._meta).toBe(false);
    } finally {
      store.close();
    }
  });

  it("marks truncated without a handle when no store is provided", () => {
    const result = makeFsEnvelopeResult("x".repeat(DEFAULT_BUDGET * 4 + 1));
    expect(result._meta.token_budget?.truncated).toBe(true);
    expect("handle_id" in result._meta).toBe(false);
  });

  it("spills an over-budget payload to a handle when a store is provided", () => {
    const store = new HandleStore();
    try {
      const result = makeFsEnvelopeResult("x".repeat(DEFAULT_BUDGET * 4 + 1), {
        handleStore: store,
      });
      const handleId = result._meta.handle_id;
      if (typeof handleId !== "string") throw new Error("expected handle_id string");
      expect(handleId.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("counts result_bytes as UTF-8 bytes", () => {
    const raw = "é".repeat(10);
    const result = makeFsEnvelopeResult(raw);
    expect(result._meta.result_bytes).toBe(20);
  });

  it("wraps over-budget payloads in a preview object counted on the visible text", () => {
    const raw = "x".repeat(40_000);
    const result = makeFsEnvelopeResult(raw);
    const first = result.content[0];
    if (!first?.text) throw new Error("missing content[0].text");
    const text = first.text;
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({ truncated: true, preview: expect.any(String) as unknown });
    if (typeof parsed !== "object" || parsed === null) throw new Error("expected JSON object");
    const preview = (parsed as Record<string, unknown>).preview;
    if (typeof preview !== "string") throw new Error("expected preview string");
    expect(raw.startsWith(preview)).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(result._meta.token_budget?.used).toBe(estimateTokens(text));
  });

  it("shrinks the preview again when JSON escaping inflates it past the budget", () => {
    const raw = '"'.repeat(40_000);
    const result = makeFsEnvelopeResult(raw);
    const first = result.content[0];
    if (!first?.text) throw new Error("missing content[0].text");
    expect(estimateTokens(first.text)).toBeLessThanOrEqual(DEFAULT_BUDGET);
    const parsed: unknown = JSON.parse(first.text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("expected JSON object");
    const preview = (parsed as Record<string, unknown>).preview;
    if (typeof preview !== "string") throw new Error("expected preview string");
    expect(preview.length).toBeGreaterThan(0);
    expect(preview).toMatch(/^"+$/);
  });
});
