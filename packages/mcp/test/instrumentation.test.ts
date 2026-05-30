import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInvocationSink, type InvocationSink } from "../src/invocation-sink.js";
import * as registry from "../src/invocation-sink-registry.js";
import {
  _resetWarnedForTest,
  instrumentHandler,
  type ToolHandler,
} from "../src/instrumentation.js";

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

function readRows(path: string): any[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line));
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
    const handler = instrumentHandler("my_tool", async () => ({ result: "ok" }), { enabled: true });

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
    const handler = instrumentHandler("t", async () => ({}), { enabled: true });

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
    const handler = instrumentHandler("t", async () => ({}), { enabled: true });

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
      const handler = instrumentHandler("t", async () => ({}), { enabled: true });

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
      const handler = instrumentHandler("t", async () => ({}), { enabled: true });

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
    const handler = instrumentHandler("t", async () => ({}), { enabled: true });
    const longOrigin = "A".repeat(500);

    await handler({}, { _meta: { origin: longOrigin } });
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].origin).toHaveLength(128);
    expect(rows[0].origin).toBe("A".repeat(128));
  });

  it("counts args_bytes / result_bytes as UTF-8 bytes, not UTF-16 code units", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", async () => ({ symbol: "€" }), { enabled: true });

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
    const handler = instrumentHandler("t", async () => huge, { enabled: true });

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].result_bytes).toBe(-1);
  });

  it("logs a failing call with error_kind from constructor name when error.name is default", async () => {
    const { path, sink } = withSink();
    class TimeoutError extends Error {}
    const handler = instrumentHandler(
      "bad",
      async () => {
        throw new TimeoutError("oops");
      },
      { enabled: true },
    );

    await expect(handler({}, {})).rejects.toThrow("oops");
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
      async () => {
        const err = new Error("boom");
        err.name = "NetworkTimeout";
        throw err;
      },
      { enabled: true },
    );

    await expect(handler({}, {})).rejects.toThrow("boom");
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toBe("NetworkTimeout");
  });

  it("caps error_kind at 64 chars", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "bad",
      async () => {
        const err = new Error("x");
        err.name = "A".repeat(200);
        throw err;
      },
      { enabled: true },
    );

    await expect(handler({}, {})).rejects.toThrow();
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toHaveLength(64);
  });

  it('returns "unknown" error_kind for non-Error throws', async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler(
      "bad",
      async () => {
        throw "string-thrown";
      },
      { enabled: true },
    );

    await expect(handler({}, {})).rejects.toBe("string-thrown");
    await sink.close();

    const rows = readRows(path);
    expect(rows[0].error_kind).toBe("unknown");
  });

  it("records args_bytes = -1 for circular args", async () => {
    const { path, sink } = withSink();
    const handler = instrumentHandler("t", async () => ({}), { enabled: true });
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
    const raw: ToolHandler = async () => ({ value: 42 });
    const wrapped = instrumentHandler("t", raw, { enabled: false });

    expect(wrapped).toBe(raw);
    await expect(wrapped({ q: 1 }, {})).resolves.toEqual({ value: 42 });
  });

  it("swallows sink write errors and still returns handler result", async () => {
    spyOn(registry, "getSink").mockReturnValue({
      write: () => {
        throw new Error("disk full");
      },
      close: async () => {},
    });
    const handler = instrumentHandler("t", async () => ({ ok: true }), { enabled: true });

    await expect(handler({}, {})).resolves.toEqual({ ok: true });
  });

  it("logs an MCP isError envelope (resolved promise) as ok:false", async () => {
    const { path, sink } = withSink();
    const errorEnvelope = {
      content: [{ type: "text", text: '{"error":"daemon_unavailable"}' }],
      isError: true,
    };
    const handler = instrumentHandler("federated_tool", async () => errorEnvelope, {
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
    const handler = instrumentHandler("t", async () => ({ ok: true }), { enabled: true });

    await expect(handler({}, {})).resolves.toEqual({ ok: true });
    await expect(handler({}, {})).resolves.toEqual({ ok: true });

    // One-shot: console.error fires once across two invocations.
    expect(warnSpy.mock.calls.length).toBe(1);
  });
});
