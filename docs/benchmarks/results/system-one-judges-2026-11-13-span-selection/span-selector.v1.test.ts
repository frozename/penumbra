import { expect, test } from "bun:test";
import { decodeSelection, sourceUnits } from "./span-selector.v1.ts";

const source = "User: This is a persistent preference that applies across future sessions because we need consistent reviewable evidence.\n\nAssistant: A task-specific proposal is unverified. It must not be generalized into a permanent project rule.";

test("source units preserve exact offsets and complete non-whitespace content", () => {
  const units = sourceUnits(source);
  expect(units.length).toBeGreaterThan(2);
  for (const unit of units) expect(source.slice(unit.start, unit.end)).toBe(unit.text);
  expect(units.map(unit => unit.text).join("").replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
});

test("decoding only copies a bounded contiguous original range without optional invented fields", () => {
  const units = sourceUnits(source);
  const value = decodeSelection({ ranges: [[units[0]?.id, units[0]?.id]] }, source);
  expect(value).toHaveLength(1);
  expect(value[0]?.body).toBe(units[0]?.text);
  expect(value[0]?.source_quote).toBe(value[0]?.body);
  expect(value[0]?.learned_at).toBeUndefined();
  expect(value[0]?.why).toBeUndefined();
});

test("unknown IDs, reversed ranges, duplicate ranges, overlaps and extra fields fail the entire selection", () => {
  const units = sourceUnits(source);
  for (const raw of [
    { ranges: [["p9999", "p9999"]] },
    { ranges: [[units[2]?.id, units[0]?.id]] },
    { ranges: [[units[0]?.id, units[0]?.id], [units[0]?.id, units[0]?.id]] },
    { ranges: [[units[0]?.id, units[2]?.id], [units[1]?.id, units[2]?.id]] },
    { ranges: [], learned_at: "2026-01-01" },
  ]) expect(() => decodeSelection(raw, source)).toThrow();
});

test("source limits and excessive/short selections fail before memory creation", () => {
  expect(() => sourceUnits("x".repeat(30001))).toThrow();
  expect(() => decodeSelection({ ranges: [["p0000", "p0000"]] }, "Short.")).toThrow();
  expect(() => decodeSelection({ ranges: Array.from({length:4},()=>["p0000","p0000"]) }, source)).toThrow();
});

test("empty valid selections remain empty without creating a replacement memory", () => {
  expect(decodeSelection({ ranges: [] }, source)).toEqual([]);
});
