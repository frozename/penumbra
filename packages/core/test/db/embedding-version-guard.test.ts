import { expect, test } from "bun:test";

import { checkEmbeddingModelVersion } from "../../src/db/embedding-version-guard.js";

test("matching versions returns null", () => {
  expect(checkEmbeddingModelVersion("v1", "v1")).toBeNull();
});

test("mismatched versions returns warning containing both versions", () => {
  const warning = checkEmbeddingModelVersion("v2", "v1");
  expect(warning).not.toBeNull();
  expect(warning).toContain("v2");
  expect(warning).toContain("v1");
});

test("null stored version returns null (fresh install)", () => {
  expect(checkEmbeddingModelVersion("v1", null)).toBeNull();
});

test("undefined stored version returns null (fresh install)", () => {
  expect(checkEmbeddingModelVersion("v1", undefined)).toBeNull();
});

test("helper never throws on any input", () => {
  expect(() => checkEmbeddingModelVersion("v1", "v2")).not.toThrow();
  expect(() => checkEmbeddingModelVersion("v1", null)).not.toThrow();
  expect(() => checkEmbeddingModelVersion("v1", undefined)).not.toThrow();
  expect(() => checkEmbeddingModelVersion("", "")).not.toThrow();
  expect(() => checkEmbeddingModelVersion("v1", "v1")).not.toThrow();
});
