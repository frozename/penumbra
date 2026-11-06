import { describe, expect, test } from "bun:test";

import { ErrorEnvelopeSchema } from "../src/index.js";

// Part of #342
// Catches: ErrorEnvelopeSchema union of string/object, code required, loose inner/top-level

describe("ErrorEnvelopeSchema", () => {
  test("accepts {error:'boom'}", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: "boom" }).success).toBe(true);
  });

  test("accepts {error:{code:'E'}} with message absent", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "E" } }).success).toBe(true);
  });

  test("keeps unknown inner keys when inner is an object", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: { code: "E", message: "m", detail: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.error as { detail?: number }).detail).toBe(1);
    }
  });

  test("keeps unknown top-level keys", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: "boom",
      extra: true,
    });
    expect(result.success).toBe(true);
  });

  test("rejects {error:{message:'m'}} because code is required", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { message: "m" } }).success).toBe(false);
  });

  test("rejects {}", () => {
    expect(ErrorEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  test("rejects {error:42}", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: 42 }).success).toBe(false);
  });
});
