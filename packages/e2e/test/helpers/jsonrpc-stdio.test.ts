import { expect, test } from "bun:test";

import { frame, parseChunks } from "./jsonrpc-stdio.js";

test("frame appends a single newline", () => {
  const out = frame({ jsonrpc: "2.0", id: 1, method: "test" });
  expect(out).toBe(`{"jsonrpc":"2.0","id":1,"method":"test"}\n`);
});

test("parseChunks yields one message per newline-delimited chunk", () => {
  const buf = `{"a":1}\n{"b":2}\n`;
  const out = [...parseChunks([new TextEncoder().encode(buf)])];
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
});

test("parseChunks reassembles split messages across chunks", () => {
  const enc = new TextEncoder();
  const chunks = [enc.encode(`{"a":`), enc.encode(`1}\n{"b":2}\n`)];
  const out = [...parseChunks(chunks)];
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
});

test("parseChunks ignores trailing partial line", () => {
  const buf = `{"a":1}\n{"b":2`;
  const out = [...parseChunks([new TextEncoder().encode(buf)])];
  expect(out).toEqual([{ a: 1 }]);
});
