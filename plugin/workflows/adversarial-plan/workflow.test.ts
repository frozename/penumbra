import { describe, expect, test } from "bun:test";
import { dedupePersonas } from "./workflow.js";

describe("dedupePersonas", () => {
  test("returns an empty array unchanged", () => {
    expect(dedupePersonas([])).toEqual([]);
  });

  test("returns unique names unchanged in declaration order", () => {
    expect(dedupePersonas(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("collapses adjacent duplicates and preserves order", () => {
    expect(dedupePersonas(["a", "a", "b"])).toEqual(["a", "b"]);
  });

  test("collapses non-adjacent duplicates and preserves first-seen order", () => {
    expect(dedupePersonas(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("collapses all-identical input to a single entry", () => {
    expect(dedupePersonas(["a", "a", "a", "a"])).toEqual(["a"]);
  });

  test("treats names as case-sensitive distinct values", () => {
    expect(dedupePersonas(["a", "A", "a"])).toEqual(["a", "A"]);
  });
});
