import { describe, expect, test } from "bun:test";

import {
  isNearDuplicate,
  type NearDuplicateItem,
  scoreMemoryQuality,
} from "@src/memory/near-dup.js";

// Integer vectors keep every cosine exact: [1,0] against [4,3] is 0.8, against [3,4] is 0.6.
function vec(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

function memory(body: string, embedding: Float32Array): NearDuplicateItem {
  return { body, embedding };
}

describe("isNearDuplicate matching", () => {
  test("matches only when similarity is strictly above the threshold", () => {
    const candidate = memory("candidate", vec(1, 0));
    const same = memory("existing", vec(1, 0));
    expect(isNearDuplicate(candidate, [same], 1)).toBeNull();
    expect(isNearDuplicate(candidate, [same], 0.99)?.similarity).toBe(1);
    const sixTenths = memory("existing", vec(3, 4));
    expect(isNearDuplicate(candidate, [sixTenths], 0.6)).toBeNull();
    expect(isNearDuplicate(candidate, [sixTenths], 0.59)?.similarity).toBe(0.6);
  });

  test("keeps the most similar match and returns that object by reference", () => {
    const candidate = memory("candidate", vec(1, 0));
    const low = { ...memory("low", vec(3, 4)), id: "low" };
    const high = { ...memory("high", vec(4, 3)), id: "high" };
    const lowAgain = { ...memory("low again", vec(3, 4)), id: "low-again" };
    const match = isNearDuplicate(candidate, [low, high, lowAgain], 0.5);
    expect(match?.existing).toBe(high);
    expect(match?.existing.id).toBe("high");
    expect(match?.similarity).toBe(0.8);
  });

  test("the first of equally similar matches wins", () => {
    const candidate = memory("candidate", vec(1, 0));
    const first = memory("first", vec(1, 0));
    const second = memory("second", vec(2, 0));
    expect(isNearDuplicate(candidate, [first, second], 0.5)?.existing).toBe(first);
  });

  test("returns null for an empty list and when nothing clears the threshold", () => {
    const candidate = memory("candidate", vec(1, 0));
    expect(isNearDuplicate(candidate, [], 0)).toBeNull();
    const below = [memory("orthogonal", vec(0, 1)), memory("six tenths", vec(3, 4))];
    expect(isNearDuplicate(candidate, below, 0.6)).toBeNull();
  });

  test("a zero-norm vector on either side has similarity 0", () => {
    const zero = memory("zero", vec(0, 0));
    const unit = memory("unit", vec(1, 0));
    expect(isNearDuplicate(zero, [unit], 0)).toBeNull();
    expect(isNearDuplicate(unit, [zero], 0)).toBeNull();
    expect(isNearDuplicate(zero, [unit], -0.5)?.similarity).toBe(0);
    expect(isNearDuplicate(unit, [zero], -0.5)?.similarity).toBe(0);
  });

  test("throws on mismatched embedding dimensions", () => {
    const candidate = memory("candidate", vec(1, 0));
    const wide = memory("wide", vec(1, 0, 0));
    expect(() => isNearDuplicate(candidate, [wide], 0.5)).toThrow(
      "near-dup cosineSim dimension mismatch: candidate=2 existing=3",
    );
  });
});

describe("isNearDuplicate winner", () => {
  const rich: NearDuplicateItem = {
    body: "x".repeat(400),
    why: "because",
    depth: 4,
    embedding: vec(1, 0),
  };

  test("equal quality scores keep the existing memory", () => {
    const candidate = memory("same body", vec(1, 0));
    const existing = memory("same body", vec(1, 0));
    expect(isNearDuplicate(candidate, [existing], 0.5)?.winner).toBe("existing");
  });

  test("a higher-quality candidate wins", () => {
    const existing = memory("short", vec(1, 0));
    expect(isNearDuplicate(rich, [existing], 0.5)?.winner).toBe("candidate");
  });

  test("a lower-quality candidate loses", () => {
    const candidate = memory("short", vec(1, 0));
    expect(isNearDuplicate(candidate, [rich], 0.5)?.winner).toBe("existing");
  });
});

type QualityInput = Pick<NearDuplicateItem, "body" | "why" | "depth">;

const QUALITY_CASES: { name: string; item: QualityInput; expected: number }[] = [
  { name: "an 80-char body scores 1", item: { body: "a".repeat(80) }, expected: 1 },
  { name: "a 40-char body scores 0.5", item: { body: "a".repeat(40) }, expected: 0.5 },
  { name: "body density is capped at 3", item: { body: "a".repeat(400) }, expected: 3 },
  { name: "an empty body scores 0", item: { body: "" }, expected: 0 },
  {
    name: "whitespace runs collapse to one space and the body is trimmed",
    item: { body: "  a    b  " },
    expected: 3 / 80,
  },
  { name: "newlines and tabs collapse like spaces", item: { body: "a\n\n\tb" }, expected: 3 / 80 },
  { name: "a non-blank why adds 1", item: { body: "", why: "because" }, expected: 1 },
  { name: "a whitespace-only why adds 0", item: { body: "", why: "   " }, expected: 0 },
  { name: "a null why adds 0", item: { body: "", why: null }, expected: 0 },
  { name: "depth 1 adds 0.5", item: { body: "", depth: 1 }, expected: 0.5 },
  { name: "depth 3 adds 1.5", item: { body: "", depth: 3 }, expected: 1.5 },
  { name: "depth 4 adds 2", item: { body: "", depth: 4 }, expected: 2 },
  { name: "depth is capped at 2", item: { body: "", depth: 10 }, expected: 2 },
  { name: "a negative depth adds 0", item: { body: "", depth: -3 }, expected: 0 },
  { name: "a null depth adds 0", item: { body: "", depth: null }, expected: 0 },
  {
    name: "density, why and depth add up",
    item: { body: "a".repeat(160), why: "w", depth: 2 },
    expected: 4,
  },
];

describe("scoreMemoryQuality", () => {
  for (const { name, item, expected } of QUALITY_CASES) {
    test(name, () => {
      expect(scoreMemoryQuality(item)).toBe(expected);
    });
  }
});
