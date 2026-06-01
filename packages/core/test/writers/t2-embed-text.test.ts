import { expect, test } from "bun:test";
import { buildT2EmbedText } from "../../src/writers/t2-embed-text.js";

test("buildT2EmbedText returns body for body_v1", () => {
  expect(buildT2EmbedText("Title", "Body", "body_v1")).toBe("Body");
});

test("buildT2EmbedText returns capped title for title_only", () => {
  const title = "T".repeat(250);
  expect(buildT2EmbedText(title, "Body", "title_only")).toBe("T".repeat(200));
});

test("buildT2EmbedText returns capped title + concise body for title_plus_concise", () => {
  const title = "A".repeat(210);
  const body = "B".repeat(300);
  expect(buildT2EmbedText(title, body, "title_plus_concise")).toBe(
    `${"A".repeat(200)}\n${"B".repeat(256)}`,
  );
});

test("buildT2EmbedText defaults to env recipe when recipe arg is omitted", () => {
  const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
  try {
    expect(buildT2EmbedText("Title", "Body")).toBe("Title");
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
  }
});
