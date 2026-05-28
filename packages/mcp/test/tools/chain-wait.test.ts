import { expect, test } from "bun:test";
import { chainWaitHandler, ChainWaitInputShape } from "../../src/tools/chain-wait.js";

test("ChainWaitInputShape requires conversation_id", () => {
  expect(() => (ChainWaitInputShape as any).conversation_id.parse(undefined)).toThrow();
  expect((ChainWaitInputShape as any).timeout_ms.parse(undefined)).toBe(60000);
});

test("chainWaitHandler polls until completed", async () => {
  let calls = 0;
  const daemon = {
    getLatestHandoff: async (conversation_id: string) => {
      calls++;
      if (calls === 1) return { handoff: { handoff_id: "h1", status: "dispatched" } };
      return { handoff: { handoff_id: "h1", status: "completed" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 1000 });

  expect(calls).toBe(2);
  expect(res.content[0].type).toBe("text");
  expect(res.content[0].text).toMatch(/^[●◑] chain_wait  /);
  expect(res.content[0].text).toContain('"status": "completed"');
  expect(res.content[0].text).toContain('"last_handoff_id": "h1"');
});

test("chainWaitHandler returns timeout if timeout_ms is reached", async () => {
  const daemon = {
    getLatestHandoff: async (conversation_id: string) => {
      return { handoff: { handoff_id: "h1", status: "dispatched" } };
    },
  } as any;

  const handler = chainWaitHandler(daemon);
  const res = await handler({ conversation_id: "conv1", timeout_ms: 100 });

  expect(res.content[0].type).toBe("text");
  expect(res.content[0].text).toMatch(/^◑ chain_wait  /);
  expect(res.content[0].text).toContain('"status": "timeout"');
});
