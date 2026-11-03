import { canonicalJson } from "@penumbra/core/evals/canonical";
import { FixturePublicSchema } from "@penumbra/core/evals/fixture";
import { EpisodeSchema } from "@penumbra/core/evals/manifest";
import { expect, test } from "bun:test";

import {
  CanonicalJsonError,
  digestOf,
  handoffRefDigest,
  recipeHash,
  sha256Hex,
  taskDigest,
} from "@src/evals/canonical.js";

test("case 23: canonicalJson sorts object keys recursively, preserves array order", () => {
  expect(canonicalJson({ b: 1, a: { d: 1, c: 2 }, l: [2, 1] })).toBe(
    '{"a":{"c":2,"d":1},"b":1,"l":[2,1]}',
  );
});

test("case 24: canonicalJson throws CanonicalJsonError on non-JSON values", () => {
  const badInputs: unknown[] = [
    { a: undefined },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    (): number => 1,
    1n,
  ];
  for (const bad of badInputs) {
    let err: unknown;
    try {
      canonicalJson(bad);
    } catch (e) {
      err = e;
    }
    expect(err instanceof CanonicalJsonError).toBe(true);
  }
});

test("case 25: sha256Hex is raw SHA-256; recipeHash ignores recipe_id, notes and created_at", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const recipe = {
    recipe_id: "r1",
    status: "ready",
    blocked_on: null,
    notes: null,
    created_at: null,
    arms: ["minimal"],
    limits: { max_rounds: 2 },
  };
  const reordered = {
    limits: { max_rounds: 2 },
    arms: ["minimal"],
    created_at: null,
    notes: null,
    blocked_on: null,
    status: "ready",
    recipe_id: "r1",
  };
  expect(recipeHash(recipe)).toBe(recipeHash(reordered));
  expect(recipeHash({ ...recipe, recipe_id: "r2" })).toBe(recipeHash(recipe));
  expect(recipeHash({ ...recipe, notes: "changed" })).toBe(recipeHash(recipe));
  expect(recipeHash({ ...recipe, created_at: "2026-11-01T10:00:00Z" })).toBe(recipeHash(recipe));
  expect(recipeHash({ ...recipe, limits: { max_rounds: 3 } })).not.toBe(recipeHash(recipe));
});

test("case 26: taskDigest normalizes CRLF/unicode; handoffRefDigest prefixes", () => {
  expect(taskDigest("a \r\nb\r\n\r\n")).toBe(taskDigest("a\nb"));
  expect(taskDigest("\u00e9")).toBe(taskDigest("e\u0301"));
  expect(taskDigest("fix a")).not.toBe(taskDigest("fix b"));
  expect(handoffRefDigest("h1")).toBe(sha256Hex("handoff:h1"));
});

test("case 26b: taskDigest normalizes a lone CR like CRLF", () => {
  expect(taskDigest("a\rb")).toBe(taskDigest("a\nb"));
  expect(taskDigest("a\r\nb")).toBe(taskDigest("a\rb"));
  expect(taskDigest("a\rb\r\n")).toBe(taskDigest("a\nb"));
});

test("case 26c: digestOf hashes canonical JSON and honors top-level omit", () => {
  expect(digestOf({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  expect(digestOf({ a: 1, b: 2 }, { omit: ["b"] })).toBe(digestOf({ a: 1 }));
  expect(digestOf({ a: 1, b: 2 })).not.toBe(digestOf({ a: 1 }));
});

test("case 27: ./evals/* package subpath exports resolve and expose the schemas", () => {
  expect(EpisodeSchema.safeParse({}).success).toBe(false);
  expect(FixturePublicSchema.safeParse({}).success).toBe(false);
  expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
});
