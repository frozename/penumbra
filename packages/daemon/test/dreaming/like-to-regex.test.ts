import { describe, expect, test } from "bun:test";

import { likeToRegex } from "@src/dreaming/curator/t2-ephemera-detector.js";

describe("likeToRegex", () => {
  test("a pattern with no % is anchored at both ends", () => {
    const re = likeToRegex("abc");
    expect(re.test("abc")).toBe(true);
    expect(re.test("xabc")).toBe(false);
    expect(re.test("abcx")).toBe(false);
  });

  test("a leading % drops only the start anchor", () => {
    const re = likeToRegex("%abc");
    expect(re.test("xxabc")).toBe(true);
    expect(re.test("abcx")).toBe(false);
  });

  test("a trailing % drops only the end anchor", () => {
    const re = likeToRegex("abc%");
    expect(re.test("abcxx")).toBe(true);
    expect(re.test("xabc")).toBe(false);
  });

  test("a middle % matches any run, including an empty one", () => {
    const re = likeToRegex("a%c");
    expect(re.test("ac")).toBe(true);
    expect(re.test("abbbc")).toBe(true);
    expect(re.test("abd")).toBe(false);
  });

  test("underscore matches exactly one character", () => {
    const re = likeToRegex("a_c");
    expect(re.test("abc")).toBe(true);
    expect(re.test("a-c")).toBe(true);
    expect(re.test("ac")).toBe(false);
    expect(re.test("abbc")).toBe(false);
  });

  test("regex metacharacters are literal", () => {
    expect(likeToRegex("a.c").test("a.c")).toBe(true);
    expect(likeToRegex("a.c").test("abc")).toBe(false);
    expect(likeToRegex("(x)+").test("(x)+")).toBe(true);
    expect(likeToRegex("(x)+").test("xx")).toBe(false);
  });

  test("matching is case-insensitive", () => {
    expect(likeToRegex("Fix bug%").test("fix BUG now")).toBe(true);
    expect(likeToRegex("x").flags).toContain("i");
  });
});
