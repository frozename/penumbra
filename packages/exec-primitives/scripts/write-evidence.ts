#!/usr/bin/env bun
/**
 * write-evidence.ts — write the committed qualification evidence pair from
 * the measured artifacts under tmp/sharedlib6/ (produced by
 * scripts/sharedlib6-check.ts --keep):
 *
 *   docs/qualification/2026-09-24-sharedlib6-qualification.json
 *   docs/qualification/2026-09-24-sharedlib6-qualification.md
 *
 * The date is fixed: the section-2 baseline numbers, the committed evidence
 * pair and the SHAPE validator all key on 2026-09-24. There is deliberately
 * no run-date default.
 *
 * The writer does NOT refuse on a non-green run: evidence records measured
 * truth. A failed gate, a missed mutation or a failed consumer step is
 * written into the record as a failure, never rewritten or omitted. Verdicts
 * in gates[] and blocker statuses are DERIVED from the fresh artifacts, never
 * asserted. The object comes from write-evidence-build.ts and the .md from
 * renderEvidenceMarkdown(): SHAPE runs the same two functions over its own
 * run and the committed .json, so a hand edit to either file fails the check.
 *
 * Usage: bun scripts/write-evidence.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Step } from "./write-evidence-gates.js";

import { measureToolchain } from "./sharedlib6-shape-env.js";
import { ARTIFACT_FILES, EVIDENCE_DATE } from "./sharedlib6-shape-util.js";
import { buildEvidence } from "./write-evidence-build.js";
import { renderEvidenceMarkdown } from "./write-evidence-md.js";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const DOCS_DIR = join(REPO_ROOT, "docs", "qualification");

function fail(msg: string): never {
  process.stderr.write(`write-evidence: FAIL — ${msg}\n`);
  process.exit(1);
}

const checkPath = join(RUN_DIR, "check.json");
if (!existsSync(checkPath)) {
  fail(`missing artifact ${checkPath} — run bun scripts/sharedlib6-check.ts --keep first`);
}
const check = JSON.parse(readFileSync(checkPath, "utf8")) as { check_steps?: unknown };
if (!Array.isArray(check.check_steps)) fail("check.json carries no check_steps[]");
const missingArtifacts = ARTIFACT_FILES.filter((f) => !existsSync(join(RUN_DIR, f)));
if (missingArtifacts.length > 0) fail(`missing run artifact(s) ${missingArtifacts.join(", ")}`);

const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).stdout.trim();
const { typescript } = measureToolchain(REPO_ROOT);
if (typescript === "") fail("tsc --version did not report a version");

let evidence: Record<string, unknown>;
try {
  evidence = buildEvidence({
    repoRoot: REPO_ROOT,
    packageDir: PACKAGE_DIR,
    runDir: RUN_DIR,
    checkSteps: check.check_steps as Step[],
    head,
    typescript,
    generatedAt: new Date().toISOString(),
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

mkdirSync(DOCS_DIR, { recursive: true });
const jsonPath = join(DOCS_DIR, `${EVIDENCE_DATE}-sharedlib6-qualification.json`);
const mdPath = join(DOCS_DIR, `${EVIDENCE_DATE}-sharedlib6-qualification.md`);
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(mdPath, renderEvidenceMarkdown(evidence));
process.stdout.write(`write-evidence: wrote ${jsonPath}\n${mdPath}\n`);
