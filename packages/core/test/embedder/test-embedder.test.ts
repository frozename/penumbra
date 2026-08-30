import { expect, test } from "bun:test";

import { TestEmbedder } from "@src/embedder/test-embedder.js";

test("TestEmbedder returns stable vectors for the same input", async () => {
  const e = new TestEmbedder({ dim: 384 });
  const a = await e.embed(["hello"]);
  const b = await e.embed(["hello"]);
  expect(a[0]!.length).toBe(384);
  expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!));
});

test("TestEmbedder returns different vectors for different inputs", async () => {
  const e = new TestEmbedder({ dim: 384 });
  const [a, b] = await e.embed(["hello", "world"]);
  const same = Array.from(a!).every((v, i) => v === b![i]);
  expect(same).toBe(false);
});

test("dim is reflected by the embedder", () => {
  const e = new TestEmbedder({ dim: 128 });
  expect(e.dim).toBe(128);
  expect(e.name).toBe("test");
});
