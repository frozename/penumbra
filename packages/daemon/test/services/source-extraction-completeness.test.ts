import { expect, test } from "bun:test";

import { wrapJudgeWithChunking } from "@src/workers/t2-promotion.js";

test("complete-input extraction refuses to drop middle chunks", async () => {
  let calls = 0;
  const judge = wrapJudgeWithChunking({
    judge: () => {
      calls++;
      return Promise.resolve([]);
    },
    maxCharsPerChunk: 30,
    maxChunks: 2,
    requireCompleteInput: true,
  });
  let error: unknown;
  try {
    await judge(Array.from({ length: 6 }, (_, i) => "User: " + String(i).repeat(20)).join("\n\n"));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(calls).toBe(0);
});

for (const concurrency of [1, 2]) {
  test(`complete-input extraction rejects partial chunk failure at concurrency ${String(concurrency)}`, async () => {
    const judge = wrapJudgeWithChunking({
      judge: (text) => {
        if (text.includes("FAIL")) throw new Error("test failure");
        return Promise.resolve([]);
      },
      maxCharsPerChunk: 30,
      concurrency,
      requireCompleteInput: true,
    });
    let error: unknown;
    try {
      await judge("User: " + "a".repeat(20) + "\n\nAssistant: FAIL " + "b".repeat(20));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  });
}
