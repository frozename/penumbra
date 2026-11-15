import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { BenchOutput } from "./system-one-judge-bench.js";

import { fixtureSchema, summarizeBench } from "./system-one-judge-bench.js";
import { comparePromotion } from "./system-one-judge-compare.js";

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { results: { type: "string" }, fixtures: { type: "string" } },
    strict: true,
  });
  if (!values.results || !values.fixtures)
    throw new Error("--results DIRECTORY --fixtures FILE; offline analysis only");
  const fixtures = readFileSync(values.fixtures, "utf8")
    .trim()
    .split("\n")
    .map((line) => fixtureSchema.parse(JSON.parse(line)));
  const runs = new Map<string, BenchOutput>();
  for (const dir of readdirSync(values.results, { withFileTypes: true })) {
    const file = join(values.results, dir.name, "run.json");
    if (!dir.isDirectory() || !existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, "utf8")) as BenchOutput;
    const ids = new Set(run.rows.map((row) => row.caseId));
    const selected = ids.size > 0 ? fixtures.filter((f) => ids.has(f.id)) : fixtures;
    const digest = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    if (digest !== run.fixtureSha256) throw new Error(`fixture mismatch: ${dir.name}`);
    writeFileSync(
      join(values.results, dir.name, "analysis.json"),
      JSON.stringify(summarizeBench(run, selected), null, 2) + "\n",
    );
    runs.set(dir.name, run);
  }
  const incumbent = runs.get("granite-c1");
  if (incumbent)
    for (const [name, candidate] of runs) {
      if (!name.endsWith("direct-c1")) continue;
      writeFileSync(
        join(values.results, name, "paired-comparison.json"),
        JSON.stringify(comparePromotion(incumbent, candidate, fixtures), null, 2) + "\n",
      );
    }
  process.stdout.write(`Analyzed ${String(runs.size)} preserved runs without inference.\n`);
}
