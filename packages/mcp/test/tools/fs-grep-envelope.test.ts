import { describe, it, expect, afterEach } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { fsGrepHandler } from "../../src/tools/fs-grep.js";

function fakeDaemon(grepInWorktree?: (handoffId: string, opts: unknown) => Promise<unknown>): any {
  return {
    grepInWorktree:
      grepInWorktree ??
      (async () => ({
        results: [],
        truncated: false,
      })),
  };
}

describe("fs_grep - envelope opt-in", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const grepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(async () => grepResult));
    const result: any = await handler({ pattern: "TODO", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const grepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(async () => grepResult));
    const result: any = await handler({ pattern: "TODO", handoff_id: "H1" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(grepResult));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const grepResult = {
      results: [{ path: "src/a.ts", line_number: 1, line: "TODO" }],
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(async () => grepResult));
    const result: any = await handler({
      pattern: "TODO",
      handoff_id: "H1",
      envelope: false,
    });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(grepResult));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const grepResult = {
      results: Array.from({ length: 4000 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        line_number: i + 1,
        line: "x".repeat(50),
      })),
      truncated: false,
    };
    const handler = fsGrepHandler(fakeDaemon(async () => grepResult));
    const result: any = await handler({ pattern: "x", handoff_id: "H1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(Buffer.byteLength(JSON.stringify(grepResult), "utf8"));
  });

  it("keeps no_handoff_context error byte-identical even when envelope=true", async () => {
    const handler = fsGrepHandler(fakeDaemon());
    const result: any = await handler({ pattern: "TODO", envelope: true });

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
