import { expect, test } from "bun:test";

import { stripPrivacyTags } from "../../src/redaction/privacy-tags.js";

test("removes content inside <private>...</private>", () => {
  expect(stripPrivacyTags("keep <private>drop me</private> keep")).toBe("keep  keep");
});

test("handles multiple tags", () => {
  expect(stripPrivacyTags("a <private>x</private> b <private>y</private> c")).toBe("a  b  c");
});

test("leaves text without tags unchanged", () => {
  expect(stripPrivacyTags("no tags here")).toBe("no tags here");
});

test("handles multiline content", () => {
  const src = "start\n<private>\nsecret line 1\nsecret line 2\n</private>\nend";
  expect(stripPrivacyTags(src)).toBe("start\n\nend");
});

test("fails closed on unclosed <private> tag (redacts to end of string)", () => {
  expect(stripPrivacyTags("deploy key <private> sk-live-abc")).toBe("deploy key ");
});

test("fails closed on unclosed tag preceded and followed by content", () => {
  expect(stripPrivacyTags("prefix <private>secret tail with no close")).toBe("prefix ");
});

test("redacts nested <private> blocks fully (no inner or outer leakage)", () => {
  expect(stripPrivacyTags("<private>A<private>B</private>C</private>")).toBe("");
});

test("nested tags with surrounding text", () => {
  expect(
    stripPrivacyTags("before <private>outer-a<private>inner</private>outer-b</private> after"),
  ).toBe("before  after");
});

test("multiple sibling tags with one nested", () => {
  expect(
    stripPrivacyTags("a <private>x</private> b <private>y<private>z</private></private> c"),
  ).toBe("a  b  c");
});

test("unclosed nested redacts everything from the outer open", () => {
  expect(stripPrivacyTags("keep <private>a<private>b</private> tail with leak")).toBe("keep ");
});

test("empty private block", () => {
  expect(stripPrivacyTags("a<private></private>b")).toBe("ab");
});
