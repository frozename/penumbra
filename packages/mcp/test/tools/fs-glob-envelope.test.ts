import { describe, it, expect, afterEach } from "bun:test";
import { HandleStore } from "../../src/handle-store.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { fsGlobHandler } from "../../src/tools/fs-glob.js";
import { readHandleHandler } from "../../src/tools/read-handle.js";

function fakeDaemon(globInWorktree?: (handoffId: string, opts: unknown) => Promise<unknown>): any {
  return {
    globInWorktree:
      globInWorktree ??
      (async () => ({
        results: ["a.ts"],
        truncated: false,
      })),
  };
}

describe("fs.glob handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result = { results: ["a.ts"], truncated: false };
    const handler = fsGlobHandler(fakeDaemon(async () => result));
    const out: any = await handler({ pattern: "*.ts", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(out)).toBe(true);
    expect(out._meta.token_budget.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result = { results: ["a.ts", "b.ts"], truncated: false };
    const handler = fsGlobHandler(fakeDaemon(async () => result));
    const out: any = await handler({ pattern: "*.ts", handoff_id: "H1" });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out.content[0].text).toBe(JSON.stringify(result));
  });

  it("keeps compact raw payload when envelope=false", async () => {
    const result = { results: ["a.ts", "b.ts"], truncated: false };
    const handler = fsGlobHandler(fakeDaemon(async () => result));
    const out: any = await handler({ pattern: "*.ts", handoff_id: "H1", envelope: false });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out.content[0].text).toBe(JSON.stringify(result));
  });

  it("spills truncated envelope payload to a handle with a valid visible preview", async () => {
    const result = {
      results: Array.from({ length: 4000 }, (_, i) => `src/path-${i}.ts`),
      truncated: false,
    };
    const rawJson = JSON.stringify(result);
    const store = new HandleStore();
    try {
      const handler = fsGlobHandler(
        fakeDaemon(async () => result),
        { handleStore: store },
      );
      const out: any = await handler({ pattern: "**/*.ts", handoff_id: "H1", envelope: true });

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
    const handler = fsGlobHandler(fakeDaemon());
    const out: any = await handler({ pattern: "*.ts", envelope: true });

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
