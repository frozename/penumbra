import { expect, test } from "bun:test";

import {
  buildT2EmbedText,
  MAX_BODY_CHARS,
  validateT2Body,
} from "../../src/writers/t2-embed-text.js";

test("buildT2EmbedText returns body for body_v1", () => {
  expect(buildT2EmbedText("Title", "Body", "body_v1")).toBe("Body");
});

test("buildT2EmbedText returns capped title for title_only", () => {
  const title = "T".repeat(250);
  expect(buildT2EmbedText(title, "Body", "title_only")).toBe("T".repeat(200));
});

test("buildT2EmbedText returns capped title + concise body for title_plus_concise", () => {
  const title = "A".repeat(210);
  const body = "B".repeat(400);
  expect(buildT2EmbedText(title, body, "title_plus_concise")).toBe(
    `${"A".repeat(200)}\n${"B".repeat(320)}`,
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

test("validateT2Body rejects oversized content", () => {
  const result = validateT2Body("x".repeat(MAX_BODY_CHARS + 1));
  expect(result).toEqual({ ok: false, reason: "length" });
});

test("validateT2Body rejects tool-call xml bleed markers", () => {
  const result = validateT2Body("Prior note <function_calls>...</function_calls> follow-up.");
  expect(result).toEqual({ ok: false, reason: "xml" });
});

test("validateT2Body accepts normal technical narrative", () => {
  const result = validateT2Body("A".repeat(1500));
  expect(result).toEqual({ ok: true });
});
