import { expect, test } from "bun:test";

import type { InputEvent } from "@src/cli/input.js";
import { parseInputStream } from "@src/cli/input.js";

interface AsyncStringIter {
  [Symbol.asyncIterator](): AsyncStringIter;
  next(): Promise<IteratorResult<string, undefined>>;
}

function asyncIter(items: string[]): AsyncStringIter {
  let i = 0;
  const iter: AsyncStringIter = {
    [Symbol.asyncIterator](): AsyncStringIter {
      return iter;
    },
    next(): Promise<IteratorResult<string, undefined>> {
      if (i < items.length) {
        return Promise.resolve({ value: items[i++]!, done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  return iter;
}

async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

test("two single-line messages separated by blank lines", async () => {
  const input = asyncIter(["hello\n", "\n", "world\n", "\n"]);
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([
    { kind: "message", text: "hello" },
    { kind: "message", text: "world" },
  ]);
});

test("one 3-line message followed by blank", async () => {
  const input = asyncIter(["line 1\n", "line 2\n", "line 3\n", "\n"]);
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([{ kind: "message", text: "line 1\nline 2\nline 3" }]);
});

test("a line done on its own emits done event", async () => {
  const input = asyncIter(["done\n"]);
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([{ kind: "done" }]);
});

test("stream ends with content in buffer emits final message", async () => {
  const input = asyncIter(["final message\n"]);
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([{ kind: "message", text: "final message" }]);
});

test("single message followed by done emits exactly one message event", async () => {
  const iter = asyncIter(["hello", "", "done"]);
  const events: InputEvent[] = [];
  for await (const ev of parseInputStream(iter)) events.push(ev);
  expect(events).toEqual([{ kind: "message", text: "hello" }, { kind: "done" }]);
});

test("parseInputStream does not re-emit messages after the for-await body resumes", async () => {
  const iter = asyncIter(["msg one", "", "approval-line", "done"]);
  let messageCount = 0;
  for await (const ev of parseInputStream(iter)) {
    if (ev.kind === "message") {
      messageCount++;
      const { value } = await iter.next();
      expect(value).toBe("approval-line");
    }
    if (ev.kind === "done") break;
  }
  expect(messageCount).toBe(1);
});

test("mode=whole concatenates all lines as a single message regardless of blank lines", async () => {
  const iter = asyncIter([
    "paragraph 1",
    "",
    "paragraph 2 line a",
    "paragraph 2 line b",
    "",
    "paragraph 3",
  ]);
  const events: InputEvent[] = [];
  for await (const ev of parseInputStream(iter, { mode: "whole" })) {
    events.push(ev);
  }
  expect(events).toEqual([
    {
      kind: "message",
      text: "paragraph 1\n\nparagraph 2 line a\nparagraph 2 line b\n\nparagraph 3",
    },
    { kind: "done" },
  ]);
});

test('mode=whole does not treat a literal "done" line as the done sentinel', async () => {
  const iter = asyncIter(["instructions follow:", "done", "final word"]);
  const events: InputEvent[] = [];
  for await (const ev of parseInputStream(iter, { mode: "whole" })) {
    events.push(ev);
  }
  expect(events).toEqual([
    { kind: "message", text: "instructions follow:\ndone\nfinal word" },
    { kind: "done" },
  ]);
});

test("mode=whole emits done with no message when input is empty", async () => {
  const iter = asyncIter([]);
  const events: InputEvent[] = [];
  for await (const ev of parseInputStream(iter, { mode: "whole" })) {
    events.push(ev);
  }
  expect(events).toEqual([{ kind: "done" }]);
});

test("default mode is split (back-compat with existing callers)", async () => {
  const iter = asyncIter(["paragraph 1", "", "paragraph 2", ""]);
  const events: InputEvent[] = [];
  for await (const ev of parseInputStream(iter)) {
    events.push(ev);
  }
  expect(events).toEqual([
    { kind: "message", text: "paragraph 1" },
    { kind: "message", text: "paragraph 2" },
  ]);
});
