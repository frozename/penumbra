import { describe, it, expect } from "bun:test";
import { toTextContent } from "@nova/mcp-shared";
import { taskListHandler } from "../../src/tools/task-list.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";

function fakeDaemon(taskList?: (arg: unknown) => Promise<unknown>): any {
  return { taskList: taskList ?? (async () => ({ tasks: [], total: 0 })) };
}

describe("task_list — envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = taskListHandler(fakeDaemon());
    const result: any = await handler({ envelope: true });
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget).toBeDefined();
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the bare TextContentEnvelope (NOT an EnvelopeResult) when envelope is omitted", async () => {
    const out = { tasks: [{ id: "t1", title: "keep default path" }], total: 1 };
    const handler = taskListHandler(fakeDaemon(async () => out));
    const result: any = await handler({});
    expect(isEnvelopeResult(result)).toBe(false);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result).toEqual(toTextContent(out));
  });

  it("does not forward the envelope flag to the daemon", async () => {
    let received: any = "UNSET";
    const handler = taskListHandler(
      fakeDaemon(async (arg: unknown) => {
        received = arg;
        return { tasks: [] };
      }),
    );
    await handler({ envelope: true });
    expect(received).not.toBeNull();
    expect(typeof received).toBe("object");
    expect("envelope" in received).toBe(false);
  });

  it("truncates the envelope text and flags it when the result exceeds the budget", async () => {
    const big = { tasks: [{ note: "x".repeat(50_000) }] };
    const handler = taskListHandler(fakeDaemon(async () => big));
    const result: any = await handler({ envelope: true });
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    const fullBytes = Buffer.byteLength(JSON.stringify(big, null, 2), "utf8");
    expect(result._meta.result_bytes).toBe(fullBytes);
  });
});
