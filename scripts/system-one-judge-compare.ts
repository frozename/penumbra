import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { BenchOutput, JudgeFixture } from "./system-one-judge-bench.js";

import { fixtureSchema } from "./system-one-judge-bench.js";
import { binaryMetrics, type BinarySample, percentile } from "./system-one-judge-metrics.js";

interface PairedMetrics extends ReturnType<typeof binaryMetrics> {
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}
export interface PromotionComparison {
  evaluation: string;
  selected: number;
  commonAnswered: number;
  missing: string[];
  incumbent: PairedMetrics;
  candidate: PairedMetrics;
  disagreements: { caseId: string; expected: boolean; incumbent: boolean; candidate: boolean }[];
}

export function comparePromotion(
  incumbent: BenchOutput,
  candidate: BenchOutput,
  fixtures: JudgeFixture[],
): PromotionComparison {
  const base = new Map(
    incumbent.rows.filter((row) => row.iteration === 0).map((row) => [row.caseId, row]),
  );
  const next = new Map(
    candidate.rows.filter((row) => row.iteration === 0).map((row) => [row.caseId, row]),
  );
  const selected = fixtures.filter(
    (f) =>
      f.workload === "promotion" && f.split === "test" && typeof f.labels.promote === "boolean",
  );
  const common = selected.filter(
    (f) =>
      base.get(f.id)?.answers.promote?.type === "noul" &&
      next.get(f.id)?.answers.promote?.type === "noul",
  );
  const metrics = (run: Map<string, BenchOutput["rows"][number]>): PairedMetrics => {
    const samples: BinarySample[] = common.map((f) => {
      const row = run.get(f.id);
      const answer = row?.answers.promote;
      return {
        expected: f.labels.promote as boolean,
        probability: answer?.type === "noul" ? answer.noul : null,
        decision: row?.incumbentDecision,
      };
    });
    const latencies = common.flatMap((f) => {
      const row = run.get(f.id);
      return row ? [row.latencyMs] : [];
    });
    return {
      ...binaryMetrics(samples),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
    };
  };
  return {
    evaluation: "provisional labels; answered common held-out cases only, not population quality",
    selected: selected.length,
    commonAnswered: common.length,
    missing: selected.filter((f) => !common.includes(f)).map((f) => f.id),
    incumbent: metrics(base),
    candidate: metrics(next),
    disagreements: common.flatMap((f) => {
      const b = base.get(f.id);
      const n = next.get(f.id);
      const ba = b?.answers.promote;
      const na = n?.answers.promote;
      if (ba?.type !== "noul" || na?.type !== "noul") return [];
      const baseDecision = b?.incumbentDecision ?? ba.noul >= 0.5;
      const candidateDecision = na.noul >= 0.5;
      return baseDecision === candidateDecision
        ? []
        : [
            {
              caseId: f.id,
              expected: f.labels.promote === true,
              incumbent: baseDecision,
              candidate: candidateDecision,
            },
          ];
    }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      incumbent: { type: "string" },
      candidate: { type: "string" },
      fixtures: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  if (!values.incumbent || !values.candidate || !values.fixtures || !values.out)
    throw new Error("--incumbent run.json --candidate run.json --fixtures FILE --out FILE");
  const fixtures = readFileSync(values.fixtures, "utf8")
    .trim()
    .split("\n")
    .map((line) => fixtureSchema.parse(JSON.parse(line)));
  const report = comparePromotion(
    JSON.parse(readFileSync(values.incumbent, "utf8")) as BenchOutput,
    JSON.parse(readFileSync(values.candidate, "utf8")) as BenchOutput,
    fixtures,
  );
  writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
}
