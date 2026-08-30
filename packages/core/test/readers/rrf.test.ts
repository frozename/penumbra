import { fuseRRF, type RankedResult } from "@src/readers/rrf.js";
import { expect, test } from "bun:test";

type Item = { tag: string };

function rr(id: string, score: number, tag: string): RankedResult<Item> {
  return { id, score, payload: { tag } };
}

test("single list passthrough", () => {
  const list = [rr("a", 0.9, "a0"), rr("b", 0.8, "b0"), rr("c", 0.7, "c0")];
  const out = fuseRRF([list]);

  expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  expect(out.map((r) => r.sources)).toEqual([[0], [0], [0]]);

  // default k=60, rank is 1-based based on input order
  expect(out[0]!.fusedScore).toBeCloseTo(1 / (60 + 1), 12);
  expect(out[1]!.fusedScore).toBeCloseTo(1 / (60 + 2), 12);
  expect(out[2]!.fusedScore).toBeCloseTo(1 / (60 + 3), 12);

  // first occurrence provenance is preserved
  expect(out[0]!.score).toBe(0.9);
  expect(out[0]!.payload.tag).toBe("a0");
});

test("two disjoint lists", () => {
  const list0 = [rr("a", 0.9, "a0"), rr("b", 0.8, "b0")];
  const list1 = [rr("c", 0.95, "c1"), rr("d", 0.85, "d1")];
  const out = fuseRRF([list0, list1]);

  expect(out.map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
  expect(out.find((r) => r.id === "a")!.sources).toEqual([0]);
  expect(out.find((r) => r.id === "b")!.sources).toEqual([0]);
  expect(out.find((r) => r.id === "c")!.sources).toEqual([1]);
  expect(out.find((r) => r.id === "d")!.sources).toEqual([1]);
});

test("two overlapping lists: overlap ranks higher than singletons", () => {
  const list0 = [rr("a", 0.9, "a0"), rr("b", 0.8, "b0"), rr("c", 0.7, "c0")];
  const list1 = [rr("x", 0.99, "x1"), rr("a", 0.2, "a1"), rr("y", 0.6, "y1")];
  const out = fuseRRF([list0, list1]);

  const a = out.find((r) => r.id === "a")!;
  const x = out.find((r) => r.id === "x")!;
  const b = out.find((r) => r.id === "b")!;

  expect(a.sources).toEqual([0, 1]);
  expect(a.fusedScore).toBeCloseTo(1 / (60 + 1) + 1 / (60 + 2), 12);
  expect(a.fusedScore).toBeGreaterThan(x.fusedScore);
  expect(a.fusedScore).toBeGreaterThan(b.fusedScore);

  // first occurrence wins on dedup
  expect(a.payload.tag).toBe("a0");
  expect(a.score).toBe(0.9);
});

test("three lists with full overlap", () => {
  const list0 = [rr("a", 0.9, "a0"), rr("b", 0.8, "b0")];
  const list1 = [rr("a", 0.1, "a1"), rr("b", 0.2, "b1")];
  const list2 = [rr("a", 0.3, "a2"), rr("b", 0.4, "b2")];
  const out = fuseRRF([list0, list1, list2]);

  expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  expect(out.map((r) => r.sources)).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);

  expect(out[0]!.fusedScore).toBeCloseTo(3 * (1 / (60 + 1)), 12);
  expect(out[1]!.fusedScore).toBeCloseTo(3 * (1 / (60 + 2)), 12);
});

test("limit cap returns top-N", () => {
  const lists: RankedResult<Item>[][] = [];
  for (let listIndex = 0; listIndex < 5; listIndex++) {
    const list: RankedResult<Item>[] = [];
    for (let i = 0; i < 100; i++) {
      const key = `${String(listIndex)}-${String(i)}`;
      list.push(rr(key, 1 - i / 1000, key));
    }
    lists.push(list);
  }

  const out = fuseRRF(lists, { limit: 10 });
  expect(out).toHaveLength(10);
});

test("k parameter: default is 60; override changes scores", () => {
  const list = [rr("a", 0.9, "a0")];

  const outDefault = fuseRRF([list]);
  expect(outDefault[0]!.fusedScore).toBeCloseTo(1 / (60 + 1), 12);

  const outK10 = fuseRRF([list], { k: 10 });
  expect(outK10[0]!.fusedScore).toBeCloseTo(1 / (10 + 1), 12);
});

test("edge cases: empty inputs and limit=0", () => {
  expect(fuseRRF([])).toEqual([]);
  expect(fuseRRF([[]])).toEqual([]);
  expect(fuseRRF([[], [], []])).toEqual([]);
  expect(fuseRRF([[rr("a", 0.9, "a0")]], { limit: 0 })).toEqual([]);
  expect(fuseRRF([[rr("a", 0.9, "a0")]], { limit: -1 })).toEqual([]);
});

test("provenance: sources includes only lists that contained the id", () => {
  const list0 = [rr("shared", 0.9, "from0")];
  const list1 = [rr("other", 0.8, "from1")];
  const list2 = [rr("shared", 0.1, "from2")];

  const out = fuseRRF([list0, list1, list2]);
  const shared = out.find((r) => r.id === "shared")!;

  expect(shared.sources).toEqual([0, 2]);
  expect(shared.payload.tag).toBe("from0");
  expect(shared.score).toBe(0.9);
});
