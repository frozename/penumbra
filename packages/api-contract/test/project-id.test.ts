import { describe, expect, test } from "bun:test";

import { SafeProjectIdSchema } from "../src/index.js";

// Part of #342
// Catches: SafeProjectIdSchema regex, absolute-path refine, traversal refine, __null__ refine

describe("SafeProjectIdSchema", () => {
  test("accepts git-kind 'abcdef0123456789:.', 'abc:packages/x', UUID-like marker, and short declared id", () => {
    expect(SafeProjectIdSchema.safeParse("abcdef0123456789:.").success).toBe(true);
    expect(SafeProjectIdSchema.safeParse("abc:packages/x").success).toBe(true);
    expect(SafeProjectIdSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(
      true,
    );
    expect(SafeProjectIdSchema.safeParse("penumbra").success).toBe(true);
  });

  test("rejects empty string", () => {
    expect(SafeProjectIdSchema.safeParse("").success).toBe(false);
  });

  test("accepts 200-char 'a' string and rejects 201-char string", () => {
    expect(SafeProjectIdSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(SafeProjectIdSchema.safeParse("a".repeat(201)).success).toBe(false);
  });

  test("rejects backslash", () => {
    const result = SafeProjectIdSchema.safeParse("a\\b");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id contains invalid characters",
      );
    }
  });

  test("rejects NUL byte", () => {
    const result = SafeProjectIdSchema.safeParse("a\u0000b");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id contains invalid characters",
      );
    }
  });

  test("rejects leading space", () => {
    const result = SafeProjectIdSchema.safeParse(" abc");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id contains invalid characters",
      );
    }
  });

  test("rejects trailing space", () => {
    const result = SafeProjectIdSchema.safeParse("abc ");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id contains invalid characters",
      );
    }
  });

  test("rejects inner space", () => {
    const result = SafeProjectIdSchema.safeParse("a b");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id contains invalid characters",
      );
    }
  });

  test("rejects absolute path '/abs'", () => {
    const result = SafeProjectIdSchema.safeParse("/abs");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "project_id must not be an absolute path",
      );
    }
  });

  test("rejects 'a/../b' and '..' with traversal message, accepts 'a..b' and 'a/./b'", () => {
    let result = SafeProjectIdSchema.safeParse("a/../b");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'project_id must not contain ".." path components',
      );
    }

    result = SafeProjectIdSchema.safeParse("..");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'project_id must not contain ".." path components',
      );
    }

    expect(SafeProjectIdSchema.safeParse("a..b").success).toBe(true);
    expect(SafeProjectIdSchema.safeParse("a/./b").success).toBe(true);
  });

  test("rejects '__null__' with __null__ message, accepts '__null__x'", () => {
    const result = SafeProjectIdSchema.safeParse("__null__");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain("project_id cannot be __null__");
    }
    expect(SafeProjectIdSchema.safeParse("__null__x").success).toBe(true);
  });
});
