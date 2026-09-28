#!/usr/bin/env bun
/**
 * sharedlib6-shape-selftest.ts — run SHAPE and its self-test probes against a
 * kept run (tmp/sharedlib6 left by `sharedlib6-check.ts --keep`) without
 * re-running the fourteen steps. The step records come from the check_steps
 * the check wrote into measurements.json. Prints one line per probe.
 *
 * Usage: bun scripts/sharedlib6-shape-selftest.ts [--evidence <json>] [--md <md>]
 * Exit 0 only when SHAPE passes on the evidence and every probe is detected.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { probeOutcomes } from "./sharedlib6-shape-probes.js";
import { type GateRec, readJsonFile, rec } from "./sharedlib6-shape-util.js";
import { buildShapeContext, validateEvidence } from "./sharedlib6-shape.js";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));

function git(args: string[]): { exit: number; output: string } {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { exit: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

const ctxProbe = buildShapeContext(REPO_ROOT, PACKAGE_DIR, [], git);
const measured = rec(readJsonFile(ctxProbe.measurements));
const steps = measured?.["check_steps"];
if (!Array.isArray(steps)) {
  process.stdout.write("shape-selftest: FAIL — no check_steps in measurements.json (run --keep)\n");
  process.exit(1);
}
const ctx = buildShapeContext(REPO_ROOT, PACKAGE_DIR, steps as GateRec[], git);
const evIdx = process.argv.indexOf("--evidence");
const evidencePath = evIdx === -1 ? ctx.evidenceJson : (process.argv[evIdx + 1] ?? "");
const evidence = rec(readJsonFile(evidencePath));
if (evidence === undefined) {
  process.stdout.write(`shape-selftest: FAIL — unreadable evidence ${evidencePath}\n`);
  process.exit(1);
}

const mdIdx = process.argv.indexOf("--md");
const mdPath = mdIdx === -1 ? ctx.evidenceMd : (process.argv[mdIdx + 1] ?? "");
const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
const baseline = validateEvidence(ctx, evidence, md);
for (const r of baseline) process.stdout.write(`SHAPE FAIL: ${r}\n`);
const outcomes = probeOutcomes(evidence, md, baseline, (ev, text) =>
  validateEvidence(ctx, ev, text),
);
for (const o of outcomes) process.stdout.write(`probe ${o.name}: ${o.status}\n`);
const detected = outcomes.filter((o) => o.status === "detected").length;
const ok = baseline.length === 0 && detected === outcomes.length;
process.stdout.write(
  `shape-selftest: ${ok ? "PASS" : "FAIL"} (baseline reasons ${String(baseline.length)}; probes detected ${String(detected)}/${String(outcomes.length)})\n`,
);
process.exit(ok ? 0 : 1);
