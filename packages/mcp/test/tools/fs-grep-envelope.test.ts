import { afterEach, describe, expect, it } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { HandleStore } from "../../src/handle-store.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { fsGrepHandler } from "../../src/tools/fs-grep.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";

type GrepDaemon = Pick<DaemonClient, "grepInWorktree">;
type GrepImpl = DaemonClient["grepInWorktree"];
type GrepResult = Awaited<ReturnType<GrepImpl>>;

function fakeDaemon(impl?: GrepImpl): GrepDaemon {
  return {
    grepInWorktree:
      impl ?? ((): Promise<GrepResult> => Promise.resolve({ results: [], truncated: false })),
  };
}

describe("fs_grep - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const grepResult: GrepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(() => Promise.resolve(grepResult)));
    const result = await handler({ pattern: "TODO", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    if (!isEnvelopeResult(result)) throw new Error("expected envelope");
    expect(result._meta.token_budget?.limit).toBe(8000);
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const grepResult: GrepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(() => Promise.resolve(grepResult)));
    const result = await handler({ pattern: "TODO", handoff_id: "H1" });

    expect(isEnvelopeResult(result)).toBe(false);
    if (isEnvelopeResult(result)) throw new Error("expected raw");
    const first = result.content[0];
    if (!first) throw new Error("missing content[0]");
    expect(first.text).toBe(JSON.stringify(grepResult));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const grepResult: GrepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(() => Promise.resolve(grepResult)));
    const result = await handler({
      pattern: "TODO",
      handoff_id: "H1",
      envelope: false,
    });

    expect(isEnvelopeResult(result)).toBe(false);
    if (isEnvelopeResult(result)) throw new Error("expected raw");
    const first = result.content[0];
    if (!first) throw new Error("missing content[0]");
    expect(first.text).toBe(JSON.stringify(grepResult));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    const grepResult: GrepResult = {
      results: Array.from({ length: 4000 }, (_, i) => ({
        path: `src/file-${String(i)}.ts`,
        line_number: i + 1,
        line: "x".repeat(50),
      })),
      truncated: false,
    };
    const rawJson = JSON.stringify(grepResult);
    const store = new HandleStore();
    try {
      const handler = fsGrepHandler(
        fakeDaemon(() => Promise.resolve(grepResult)),
        { handleStore: store },
      );
      const result = await handler({ pattern: "x", handoff_id: "H1", envelope: true });

      expect(isEnvelopeResult(result)).toBe(true);
      if (!isEnvelopeResult(result)) throw new Error("expected envelope");
      expect(result._meta.token_budget?.truncated).toBe(true);
      expect(typeof result._meta.handle_id).toBe("string");
      const first = result.content[0];
      if (!first?.text) throw new Error("missing content[0].text");
      expect(JSON.parse(first.text)).toEqual({
        truncated: true,
        preview: expect.any(String) as unknown,
      });
      expect(result._meta.result_bytes).toBe(Buffer.byteLength(rawJson, "utf8"));

      const handleId = result._meta.handle_id;
      if (typeof handleId !== "string") throw new Error("expected handle_id string");
      const full = await readHandleHandler(store)({ handle_id: handleId });
      const fullFirst = full.content[0];
      if (!fullFirst) throw new Error("missing content[0]");
      expect(fullFirst.text).toBe(rawJson);
    } finally {
      store.close();
    }
  });

  it("keeps no_handoff_context error byte-identical even when envelope=true", async () => {
    const handler = fsGrepHandler(fakeDaemon());
    const result = await handler({ pattern: "TODO", envelope: true });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "no_handoff_context",
              message:
                "pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)",
            },
          }),
        },
      ],
      isError: true,
    });
  });
});
