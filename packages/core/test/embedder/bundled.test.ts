import { BundledEmbedder } from "@src/embedder/bundled.js";
import { expect, test } from "bun:test";

// Skip if the env flag opt-out is set — CI without net access.
const SKIP = process.env.PENUMBRA_SKIP_ONNX === "1";

const maybeTest = SKIP ? test.skip : test;

maybeTest("BundledEmbedder loads the model and returns 384-dim vectors", async () => {
  const e = new BundledEmbedder();
  await e.ready();
  const v = await e.embed(["hello world"]);
  expect(e.dim).toBe(384);
  expect(v[0]!.length).toBe(384);
  expect(e.name).toBe("fastembed-minilm-l6-v2");
});

maybeTest("BundledEmbedder vectors are deterministic for the same input", async () => {
  const e = new BundledEmbedder();
  await e.ready();
  const a = await e.embed(["hello"]);
  const b = await e.embed(["hello"]);
  expect(Array.from(a[0]!.slice(0, 8))).toEqual(Array.from(b[0]!.slice(0, 8)));
});
