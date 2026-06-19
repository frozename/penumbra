import { describe, it, expect, afterEach } from "bun:test";
import { HandleStore } from "../../src/handle-store.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { fsEditHandler } from "../../src/tools/fs-edit.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";

function fakeDaemon(editInWorktree?: (handoffId: string, opts: unknown) => Promise<unknown>): any {
  return {
    editInWorktree: editInWorktree ?? (async () => ({ path: "file.txt", replacements: 1 })),
  };
}

describe("fs.edit handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result = { path: "file.txt", replacements: 1 };
    const handler = fsEditHandler(fakeDaemon(async () => result));
    const out: any = await handler({
      path: "file.txt",
      old_string: "old",
      new_string: "new",
      handoff_id: "H1",
      envelope: true,
    });

    expect(isEnvelopeResult(out)).toBe(true);
    expect(out._meta.token_budget.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result = { path: "file.txt", replacements: 1 };
    const handler = fsEditHandler(fakeDaemon(async () => result));
    const out: any = await handler({
      path: "file.txt",
      old_string: "old",
      new_string: "new",
      handoff_id: "H1",
    });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out.content[0].text).toBe(JSON.stringify(result));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    const result = {
      path: "file.txt",
      replacements: 1,
      diagnostics: "x".repeat(40_000),
    };
    const rawJson = JSON.stringify(result);
    const store = new HandleStore();
    try {
      const handler = fsEditHandler(
        fakeDaemon(async () => result),
        { handleStore: store },
      );
      const out: any = await handler({
        path: "file.txt",
        old_string: "old",
        new_string: "new",
        handoff_id: "H1",
        envelope: true,
      });

      expect(isEnvelopeResult(out)).toBe(true);
      expect(out._meta.token_budget.truncated).toBe(true);
      expect(typeof out._meta.handle_id).toBe("string");
      expect(JSON.parse(out.content[0].text)).toEqual({
        truncated: true,
        preview: expect.any(String),
      });
      expect(out._meta.result_bytes).toBe(Buffer.byteLength(rawJson, "utf8"));

      const full: any = await readHandleHandler(store)({ handle_id: out._meta.handle_id });
      expect(full.content[0].text).toBe(rawJson);
    } finally {
      store.close();
    }
  });

  it("keeps no_handoff_context error shape even when envelope=true", async () => {
    const handler = fsEditHandler(fakeDaemon());
    const out: any = await handler({
      path: "f.txt",
      old_string: "old",
      new_string: "new",
      envelope: true,
    });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out).toEqual({
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
