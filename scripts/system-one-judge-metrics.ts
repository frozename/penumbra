export interface BinarySample {
  expected: boolean;
  probability: number | null;
  decision?: boolean;
}
export interface CategoricalSample {
  expected: string;
  selected: string | null;
  probabilities: Record<string, number> | null;
}

export interface BinaryMetrics {
  selected: number;
  answered: number;
  abstained: number;
  coverage: number | null;
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePromotionRate: number | null;
  falseVetoRate: number | null;
  falseDiscoveryRate: number | null;
  brier: number | null;
  calibrationError: number | null;
  falseVetoRateWithRejectFallback: number | null;
}
export interface CategoricalMetrics {
  selected: number;
  answered: number;
  accuracy: number | null;
  macroF1: number | null;
  perClass: Record<string, BinaryMetrics>;
  brier: number | null;
  calibrationError: number | null;
}

const divide = (n: number, d: number): number | null => (d === 0 ? null : n / d);
export function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
}

function calibrationError(rows: { probability: number; outcome: number }[]): number | null {
  if (rows.length === 0) return null;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const row of rows) {
    const bin = bins[Math.min(9, Math.floor(row.probability * 10))];
    if (!bin) throw new Error("invalid calibration bin");
    bin.n++;
    bin.p += row.probability;
    bin.y += row.outcome;
  }
  return bins.reduce((sum, bin) => sum + Math.abs(bin.p - bin.y), 0) / rows.length;
}

export function binaryMetrics(rows: BinarySample[], threshold = 0.5): BinaryMetrics {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("invalid threshold");
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0,
    squaredError = 0;
  const calibration: { probability: number; outcome: number }[] = [];
  for (const { expected, probability, decision } of rows) {
    if (probability === null) continue;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1)
      throw new Error("invalid probability");
    const predicted = decision ?? probability >= threshold;
    if (expected && predicted) tp++;
    else if (expected) fn++;
    else if (predicted) fp++;
    else tn++;
    squaredError += (probability - Number(expected)) ** 2;
    calibration.push({ probability, outcome: Number(expected) });
  }
  const answered = calibration.length;
  return {
    selected: rows.length,
    answered,
    abstained: rows.length - answered,
    coverage: divide(answered, rows.length),
    threshold,
    tp,
    fp,
    tn,
    fn,
    precision: divide(tp, tp + fp),
    recall: divide(tp, tp + fn),
    f1: divide(2 * tp, 2 * tp + fp + fn),
    falsePromotionRate: divide(fp, fp + tn),
    falseVetoRate: divide(fn, fn + tp),
    falseDiscoveryRate: divide(fp, fp + tp),
    brier: divide(squaredError, answered),
    calibrationError: calibrationError(calibration),
    falseVetoRateWithRejectFallback: divide(
      fn + rows.filter((row) => row.expected && row.probability === null).length,
      rows.filter((row) => row.expected).length,
    ),
  };
}

export function categoricalMetrics(rows: CategoricalSample[]): CategoricalMetrics {
  const answered = rows.filter((row) => row.selected !== null && row.probabilities !== null);
  const classes = [...new Set(rows.map((row) => row.expected))].sort();
  const perClass = Object.fromEntries(
    classes.map((label) => [
      label,
      binaryMetrics(
        rows.map((row) => ({
          expected: row.expected === label,
          probability: row.selected === null ? null : Number(row.selected === label),
        })),
      ),
    ]),
  );
  const f1s = Object.values(perClass).flatMap((row) => (row.f1 === null ? [] : [row.f1]));
  return {
    selected: rows.length,
    answered: answered.length,
    accuracy: divide(
      answered.filter((row) => row.selected === row.expected).length,
      answered.length,
    ),
    macroF1: divide(
      f1s.reduce((sum, f1) => sum + f1, 0),
      f1s.length,
    ),
    perClass,
    brier: divide(
      answered.reduce(
        (sum, row) =>
          sum +
          Object.entries(row.probabilities ?? {}).reduce(
            (s, [label, p]) => s + (p - Number(label === row.expected)) ** 2,
            0,
          ),
        0,
      ),
      answered.length,
    ),
    calibrationError: calibrationError(
      answered.map((row) => ({
        probability: row.probabilities?.[row.selected ?? ""] ?? 0,
        outcome: Number(row.selected === row.expected),
      })),
    ),
  };
}

export function selectThreshold(
  calibration: BinarySample[],
  maxFalsePromotionRate: number,
): number | null {
  if (!calibration.some((row) => row.expected) || !calibration.some((row) => !row.expected))
    return null;
  const candidates = Array.from({ length: 101 }, (_, i) => i / 100)
    .map((threshold) => binaryMetrics(calibration, threshold))
    .filter(
      (row) => row.falsePromotionRate !== null && row.falsePromotionRate <= maxFalsePromotionRate,
    );
  candidates.sort((a, b) => (b.recall ?? 0) - (a.recall ?? 0) || b.threshold - a.threshold);
  return candidates[0]?.threshold ?? null;
}
