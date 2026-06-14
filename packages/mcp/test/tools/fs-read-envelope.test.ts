import { describe, it, expect, afterEach } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { fsReadHandler } from "../../src/tools/fs-read.js";

function fakeDaemon(readInWorktree?: (handoffId: string, opts: unknown) => Promise<unknown>): any {
  return {
    readInWorktree:
      readInWorktree ??
      (async () => ({ content: "hello", path: "hello.txt", bytes: 5, truncated: false })),
  };
}

describe("fs.read handler - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const result = { content: "hello", path: "hello.txt", bytes: 5, truncated: false };
    const handler = fsReadHandler(fakeDaemon(async () => result));
    const out: any = await handler({ path: "hello.txt", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(out)).toBe(true);
    expect(out._meta.token_budget.limit).toBe(8000);
  });

  it("keeps compact raw payload when envelope is omitted", async () => {
    const result = { content: "hello", path: "hello.txt", bytes: 5, truncated: false };
    const handler = fsReadHandler(fakeDaemon(async () => result));
    const out: any = await handler({ path: "hello.txt", handoff_id: "H1" });

    expect(isEnvelopeResult(out)).toBe(false);
    expect(out.content[0].text).toBe(JSON.stringify(result));
  });

  it("keeps no_handoff_context error shape even when envelope=true", async () => {
    const handler = fsReadHandler(fakeDaemon());
    const out: any = await handler({ path: "f.txt", envelope: true });

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
