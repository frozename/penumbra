import { expect, test } from "bun:test";

import { parseWikiLinks } from "@src/writers/wiki-links.js";

test("parseWikiLinks ignores case-only variants consistently across repeated calls", () => {
  const body = "Keep [[Foo-Bar]] hidden but keep [[foo-bar]] linked";

  let first: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const parsed = parseWikiLinks(body);
    if (i === 0) {
      first = parsed;
    } else {
      expect(parsed).toEqual(first);
    }
  }
});

test("parseWikiLinks matches only lowercase slugs", () => {
  const body = "Mixed: [[Foo-Bar]] and [[foo-bar]]";
  const parsed = parseWikiLinks(body);
  expect(parsed).toEqual(["foo-bar"]);
});
