import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HandleStore } from "../src/handle-store.js";
import {
  _resetWarnedForTest,
  instrumentHandler,
  type ToolHandler,
} from "../src/instrumentation.js";
import * as registry from "../src/invocation-sink-registry.js";
import {
  type InvocationRow,
  type InvocationSink,
  openInvocationSink,
} from "../src/invocation-sink.js";
import { estimateTokens, sliceSurrogateSafe } from "../src/responses/budget.js";
import { type EnvelopeResult, isEnvelopeResult } from "../src/responses/envelope.js";

function expectedBudgetMarker(handleId: string, usedTokens: number, limitTokens: number): string {
  return `\n[truncated: ${String(usedTokens)} tokens > ${String(limitTokens)} token budget — full payload: read_handle ${handleId}]`;
}

let tempDirs: string[] = [];

function makeTempDir(prefix = "mcp-wrap-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withSink(): { path: string; sink: InvocationSink } {
  const dir = makeTempDir();
  const path = join(dir, "inv.jsonl");
  const sink = openInvocationSink(path);
  spyOn(registry, "getSink").mockReturnValue(sink);
  return { path, sink };
}

function readRows(path: string): InvocationRow[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as InvocationRow);
}

function expectEnvelope(value: unknown): EnvelopeResult {
  if (!isEnvelopeResult(value)) throw new Error("expected envelope result");
  return value;
}

function expectTokenBudget(envelope: EnvelopeResult): {
  used: number;
  limit: number;
  truncated: boolean;
} {
  const tb = envelope._meta.token_budget;
  if (!tb) throw new Error("expected token_budget on envelope");
  return tb;
}

function expectHandleId(envelope: EnvelopeResult): string {
  const id = envelope._meta.handle_id;
  if (id === undefined) throw new Error("expected handle_id on envelope");
  return id;
}

function expectFirstText(envelope: EnvelopeResult): string {
  const block = envelope.content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected text content block");
  }
  return block.text;
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("promise unexpectedly resolved");
}

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  _resetWarnedForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("instrumentHandler", () => {
  it("logs a successful call (origin from _meta, fields correct)", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("my_tool", () => Promise.resolve({ result: "ok" }), {
      enabled: true,
    });

    await handler({ x: 1 }, { _meta: { origin: "claude-code" } });
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("my_tool");
    expect(rows[0].origin).toBe("claude-code");
    expect(rows[0].ok).toBe(true);
    expect(rows[0].error_kind).toBeNull();
    expect(typeof rows[0].duration_ms).toBe("number");
    expect(rows[0].args_bytes).toBe(Buffer.byteLength(JSON.stringify({ x: 1 }), "utf8"));
    expect(rows[0].result_bytes).toBe(Buffer.byteLength(JSON.stringify({ result: "ok" }), "utf8"));
  });

  it("resolves origin per-call via header (not closure-captured)", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });

    await handler({}, { requestInfo: { headers: { "x-penumbra-origin": "caller-A" } } });
    await handler({}, { requestInfo: { headers: { "x-penumbra-origin": "caller-B" } } });
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(2);
    expect(rows[0].origin).toBe("caller-A");
    expect(rows[1].origin).toBe("caller-B");
  });

  it('defaults origin to "unknown" when extra has no origin signal', async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("unknown");
  });

  it("uses PENUMBRA_MCP_ORIGIN when request metadata/header is absent", async () => {
    const prev = process.env.PENUMBRA_MCP_ORIGIN;
    process.env.PENUMBRA_MCP_ORIGIN = "fleet-worker";
    try {
      const { path, sink } = withSink();
      const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });

      await handler({}, {});
      await sink.close();

      const rows = readRows(path);
      expect(rows).toHaveLength(1);
      expect(rows[0].origin).toBe("fleet-worker");
    } finally {
      if (prev === undefined) {
        delete process.env.PENUMBRA_MCP_ORIGIN;
      } else {
        process.env.PENUMBRA_MCP_ORIGIN = prev;
      }
    }
  });

  it("prefers _meta.origin over PENUMBRA_MCP_ORIGIN fallback", async () => {
    const prev = process.env.PENUMBRA_MCP_ORIGIN;
    process.env.PENUMBRA_MCP_ORIGIN = "fleet-worker";
    try {
      const { path, sink } = withSink();
      const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });

      await handler({}, { _meta: { origin: "maestro" } });
      await sink.close();

      const rows = readRows(path);
      expect(rows).toHaveLength(1);
      expect(rows[0].origin).toBe("maestro");
    } finally {
      if (prev === undefined) {
        delete process.env.PENUMBRA_MCP_ORIGIN;
      } else {
        process.env.PENUMBRA_MCP_ORIGIN = prev;
      }
    }
  });

  it("caps caller-controlled origin at 128 chars (prevents disk-exhaustion vector)", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });
    const longOrigin = "A".repeat(500);

    await handler({}, { _meta: { origin: longOrigin } });
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].origin).toHaveLength(128);
    expect(rows[0].origin).toBe("A".repeat(128));
  });

  it("counts args_bytes / result_bytes as UTF-8 bytes, not UTF-16 code units", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({ symbol: "€" }), {
      enabled: true,
    });

    await handler({ payload: "€" }, {});
    await sink.close();

    const rows = readRows(path);
    // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes; the field's name says "bytes".
    expect(rows[0].args_bytes).toBe(Buffer.byteLength(JSON.stringify({ payload: "€" }), "utf8"));
    expect(rows[0].args_bytes).toBeGreaterThan(JSON.stringify({ payload: "€" }).length);
    expect(rows[0].result_bytes).toBe(Buffer.byteLength(JSON.stringify({ symbol: "€" }), "utf8"));
  });

  it("records -1 sentinel for result_bytes when serialized payload exceeds 1 MiB cap", async () => {
    const { path, sink } = withSink();
    // Build a result whose JSON encoding exceeds the 1 MiB cap so a downstream
    // consumer can identify "we did not bound this measurement".
    const huge = { blob: "x".repeat(1_100_000) };
    const handler = instrumentHandler("t", () => Promise.resolve(huge), { enabled: true });

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].result_bytes).toBe(-1);
  });

  it("logs a failing call with error_kind from constructor name when error.name is default", async () => {
    const { path, sink } = withSink();
    class TimeoutError extends Error {}
    const handler = instrumentHandler("bad", () => Promise.reject(new TimeoutError("oops")), {
      enabled: true,
    });

    const err = await expectRejection(handler({}, {}));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("oops");
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error_kind).toBe("TimeoutError");
    expect(rows[0].result_bytes).toBe(-1);
  });

  it("logs a failing call preferring explicit error.name over constructor name", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "bad",
      () => {
        const err = new Error("boom");
        err.name = "NetworkTimeout";
        return Promise.reject(err);
      },
      { enabled: true },
    );

    const err = await expectRejection(handler({}, {}));
    expect((err as Error).message).toBe("boom");
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toBe("NetworkTimeout");
  });

  it("caps error_kind at 64 chars", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "bad",
      () => {
        const err = new Error("x");
        err.name = "A".repeat(200);
        return Promise.reject(err);
      },
      { enabled: true },
    );

    await expectRejection(handler({}, {}));
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toHaveLength(64);
  });

  it('returns "unknown" error_kind for non-Error throws', async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "bad",
      async () => {
        // Touch the microtask queue so this stays inside the async-arrow contract
        // without an unreachable Promise.reject() (which `prefer-promise-reject-errors`
        // rejects for non-Error reasons even when the runtime test is non-Error).
        await Promise.resolve();
        const thrown: unknown = "string-thrown";
        throw thrown;
      },
      { enabled: true },
    );

    const err = await expectRejection(handler({}, {}));
    expect(err).toBe("string-thrown");
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toBe("unknown");
  });

  it("records args_bytes = -1 for circular args", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({}), { enabled: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await handler(circular, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].args_bytes).toBe(-1);
  });

  it("records ts at invocation start, not completion", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "t",
      async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {};
      },
      { enabled: true },
    );

    const beforeWall = Date.now();
    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    const tsMs = new Date(rows[0].ts).getTime();
    // ts should be at or just after invocation start (within ~5ms), well before completion (+40ms).
    expect(tsMs).toBeGreaterThanOrEqual(beforeWall);
    expect(tsMs - beforeWall).toBeLessThan(20);
  });

  it("duration_ms is an integer", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "t",
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {};
      },
      { enabled: true },
    );

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(Number.isInteger(rows[0].duration_ms)).toBe(true);
  });

  it("is a no-op when opts.enabled is false (raw handler returned)", async () => {
    const raw: ToolHandler = () => Promise.resolve({ value: 42 });
    const wrapped = instrumentHandler("t", raw, { enabled: false });

    expect(wrapped).toBe(raw);
    expect(await wrapped({ q: 1 }, {})).toEqual({ value: 42 });
  });

  it("swallows sink write errors and still returns handler result", async () => {
    spyOn(registry, "getSink").mockReturnValue({
      write: () => {
        throw new Error("disk full");
      },
      close: () => Promise.resolve(),
    });
    const handler = instrumentHandler("t", () => Promise.resolve({ ok: true }), { enabled: true });

    expect(await handler({}, {})).toEqual({ ok: true });
  });

  it("logs an MCP isError envelope (resolved promise) as ok:false", async () => {
    const { path, sink } = withSink();
    const errorEnvelope = {
      content: [{ type: "text", text: '{"error":"daemon_unavailable"}' }],
      isError: true,
    };
    const handler = instrumentHandler("federated_tool", () => Promise.resolve(errorEnvelope), {
      enabled: true,
    });

    const result = await handler({}, {});
    await sink.close();

    expect(result).toBe(errorEnvelope);
    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error_kind).toBe("mcp_error_envelope");
  });

  it("swallows getSink throw (uninitialized sink) and emits a one-shot warning", async () => {
    spyOn(registry, "getSink").mockImplementation(() => {
      throw new Error("not initialized");
    });
    const warnSpy = spyOn(console, "error");
    const handler = instrumentHandler("t", () => Promise.resolve({ ok: true }), { enabled: true });

    expect(await handler({}, {})).toEqual({ ok: true });
    expect(await handler({}, {})).toEqual({ ok: true });

    // One-shot: console.error fires once across two invocations.
    expect(warnSpy.mock.calls.length).toBe(1);
  });
});

describe("instrumentHandler response budget", () => {
  it("ignores PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS in env — budget comes only from options", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    try {
      const large = { blob: "x".repeat(256) };
      const raw: ToolHandler = () => Promise.resolve(large);
      const wrapped = instrumentHandler("t", raw, { enabled: false });
      // No explicit budget option -> no budgeting wrap at all.
      expect(wrapped).toBe(raw);
      expect(await wrapped({}, {})).toBe(large);
    } finally {
      delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
    }
  });

  it("budget without a handle store is a hard no-op — result passes through unbudgeted", async () => {
    const large = { blob: "x".repeat(256) };
    const raw: ToolHandler = () => Promise.resolve(large);
    const wrapped = instrumentHandler("t", raw, { enabled: false, responseBudgetTokens: 1 });
    // Never truncate unrecoverably: with nowhere to spill, budgeting must not engage.
    expect(wrapped).toBe(raw);
    expect(await wrapped({}, {})).toBe(large);
  });

  it("passes an unserializable result through when budgeting is active (stringify must not break execution)", async () => {
    const store = new HandleStore();
    try {
      const poisoned = { big: 1n };
      const handler = instrumentHandler("t", () => Promise.resolve(poisoned), {
        enabled: false,
        responseBudgetTokens: 1,
        handleStore: store,
      });
      expect(await handler({}, {})).toBe(poisoned);
    } finally {
      store.close();
    }
  });

  it("does not touch the sink on handler throw when only budgeting is enabled", async () => {
    const getSinkSpy = spyOn(registry, "getSink");
    const store = new HandleStore();
    try {
      const handler = instrumentHandler("t", () => Promise.reject(new Error("boom")), {
        enabled: false,
        responseBudgetTokens: 1,
        handleStore: store,
      });
      const err = await expectRejection(handler({}, {}));
      expect((err as Error).message).toBe("boom");
      expect(getSinkSpy).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("spills an oversized result to the handle store and truncates the envelope text", async () => {
    const store = new HandleStore();
    try {
      const large = { blob: "y".repeat(256) };
      const handler = instrumentHandler("t", () => Promise.resolve(large), {
        enabled: false,
        responseBudgetTokens: 1,
        handleStore: store,
      });
      const out = expectEnvelope(await handler({}, {}));
      const budget = expectTokenBudget(out);
      const handleId = expectHandleId(out);
      expect(out.isEnvelope).toBe(true);
      expect(budget.truncated).toBe(true);
      expect(store.get(handleId)).toBe(JSON.stringify(large));
    } finally {
      store.close();
    }
  });

  it("adds an inline recovery marker that stays within budget and round-trips via HandleStore", async () => {
    const store = new HandleStore();
    try {
      const limitTokens = 48;
      const large = {
        blob: "z".repeat(256),
        nested: { ok: true, note: "recover this payload" },
      };
      const handler = instrumentHandler("t", () => Promise.resolve(large), {
        enabled: true,
        responseBudgetTokens: limitTokens,
        handleStore: store,
      });

      const out = expectEnvelope(await handler({}, {}));
      const budget = expectTokenBudget(out);
      const handleId = expectHandleId(out);
      const marker = expectedBudgetMarker(handleId, budget.used, limitTokens);
      const fullPayload = JSON.stringify(large);
      const text = expectFirstText(out);
      const block = out.content[0];

      expect(out.isEnvelope).toBe(true);
      expect(budget.truncated).toBe(true);
      expect(budget.used).toBe(estimateTokens(fullPayload));
      expect(budget.limit).toBe(limitTokens);
      expect(out._meta.result_bytes).toBe(Buffer.byteLength(fullPayload, "utf8"));
      expect(handleId).toBeTruthy();
      expect(out.content).toHaveLength(1);
      expect(block?.type).toBe("text");
      expect(text).toContain(marker);
      expect(text.endsWith(marker)).toBe(true);
      expect(estimateTokens(text)).toBeLessThanOrEqual(limitTokens);
      expect(store.get(handleId)).toBe(fullPayload);
    } finally {
      store.close();
    }
  });

  it("builds the recovery envelope with the marker text already in content", async () => {
    const store = new HandleStore();
    try {
      const limitTokens = 12;
      const large = { blob: "q".repeat(128), tail: "end" };
      const handler = instrumentHandler("t", () => Promise.resolve(large), {
        enabled: false,
        responseBudgetTokens: limitTokens,
        handleStore: store,
      });

      const out = expectEnvelope(await handler({}, {}));
      const budget = expectTokenBudget(out);
      const handleId = expectHandleId(out);
      const marker = expectedBudgetMarker(handleId, budget.used, limitTokens);
      const allowedBodyChars = (limitTokens - estimateTokens(marker)) * 4;
      const expectedBody = sliceSurrogateSafe(JSON.stringify(large), Math.max(0, allowedBodyChars));
      const text = expectFirstText(out);

      expect(out.isEnvelope).toBe(true);
      expect(out.content).toHaveLength(1);
      expect(text).toBe(`${expectedBody}${marker}`);
      expect(text.endsWith(marker)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("records pid on invocation log rows", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", () => Promise.resolve({ ok: true }), { enabled: true });

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(process.pid);
  });
});
