import { expect, test } from "bun:test";

import { binaryMetrics, categoricalMetrics, selectThreshold } from "./system-one-judge-metrics.js";

test("binary metrics use labels, preserve abstentions, and distinguish FPR from false discovery", () => {
  const result = binaryMetrics([
    { expected: true, probability: 0.9 },
    { expected: true, probability: 0.2 },
    { expected: false, probability: 0.7 },
    { expected: false, probability: 0.1 },
    { expected: true, probability: null },
  ]);
  expect(result).toMatchObject({
    selected: 5,
    answered: 4,
    abstained: 1,
    tp: 1,
    fp: 1,
    tn: 1,
    fn: 1,
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
    falsePromotionRate: 0.5,
    falseVetoRate: 0.5,
    coverage: 0.8,
  });
  expect(result.brier).toBeCloseTo((0.01 + 0.64 + 0.49 + 0.01) / 4);
});

test("empty and one-class slices expose undefined metrics", () => {
  expect(binaryMetrics([])).toMatchObject({
    precision: null,
    recall: null,
    brier: null,
    calibrationError: null,
  });
  expect(binaryMetrics([{ expected: false, probability: 0.01 }])).toMatchObject({
    recall: null,
    falseVetoRate: null,
  });
});

test("invalid probabilities never enter calibration", () => {
  for (const probability of [NaN, Infinity, -0.1, 1.1])
    expect(() => binaryMetrics([{ expected: true, probability }])).toThrow();
});

test("categorical calibration uses selected-option probability, not provider confidence", () => {
  expect(
    categoricalMetrics([
      { expected: "a", selected: "a", probabilities: { a: 0.75, b: 0.25 } },
      { expected: "b", selected: "a", probabilities: { a: 0.8, b: 0.2 } },
    ]),
  ).toMatchObject({ accuracy: 0.5 });
});

test("threshold fitting uses only explicitly supplied calibration rows", () => {
  expect(
    selectThreshold(
      [
        { expected: true, probability: 0.7 },
        { expected: false, probability: 0.6 },
      ],
      0,
    ),
  ).toBeGreaterThan(0.6);
  expect(selectThreshold([], 0.02)).toBeNull();
});

test("incumbent confidence cannot invert its actual boolean ballot", () => {
  expect(binaryMetrics([{ expected: true, probability: 0.2, decision: true }])).toMatchObject({
    tp: 1,
    fn: 0,
    brier: 0.6400000000000001,
  });
});
