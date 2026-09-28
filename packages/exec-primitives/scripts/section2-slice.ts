#!/usr/bin/env bun
/**
 * section2-slice.ts — measure the section-2 baseline: the retained
 * packages/agentchat adapter test files the extraction drew from, run in
 * place against the unmodified origin sources, plus the
 * packages/agentchat/test/cli context slice.
 *
 * Writes tmp/sharedlib6/section2.json with per-file pass/fail counts, the
 * executed test titles, and the baseline table the run is asserted against —
 * the evidence's section-2 block and the shape validator both compare against
 * this record. The baseline is the Keep list: it exists to catch drift on
 * this branch, not to waive it.
 *
 * Usage: bun scripts/section2-slice.ts --out <path>
 * Exits 0 when every slice ran to a summary AND matched its baseline count;
 * exits 1 when any slice fails, errors, drifts, or never reaches its
 * "Ran N tests" line.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { agentFreeEnv, bunTestResultText, parseBunTest } from "./bun-test-parse.js";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));

/** Retained section-2 origin slices — one entry per adapter test file plus
 * the packages/agentchat/test/cli context directory. */
const ORIGIN_SLICES = [
  "packages/agentchat/test/adapters/cli-spawn.test.ts",
  "packages/agentchat/test/adapters/cli-spawn-stream.test.ts",
  "packages/agentchat/test/adapters/stdio-acp-client.test.ts",
  "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts",
  "packages/agentchat/test/adapters/stdio-acp-server.test.ts",
  "packages/agentchat/test/adapters/stdio-acp-permission.test.ts",
  "packages/agentchat/test/adapters/acp-warm-pool.test.ts",
  "packages/agentchat/test/cli",
];

/** Keep baseline — measured pass counts for each origin slice on this
 * branch. Any drift fails the slice, not just a non-zero exit. */
const BASELINE_PASS: Record<string, number> = {
  "packages/agentchat/test/adapters/cli-spawn.test.ts": 24,
  "packages/agentchat/test/adapters/cli-spawn-stream.test.ts": 14,
  "packages/agentchat/test/adapters/stdio-acp-client.test.ts": 11,
  "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts": 6,
  "packages/agentchat/test/adapters/stdio-acp-server.test.ts": 5,
  "packages/agentchat/test/adapters/stdio-acp-permission.test.ts": 29,
  "packages/agentchat/test/adapters/acp-warm-pool.test.ts": 22,
  "packages/agentchat/test/cli": 71,
};

interface SliceRecord {
  exit: number;
  pass: number;
  fail: number;
  ran: number;
  baseline: number;
  failing: string[];
  titles: string[];
  reached_summary: boolean;
}

/** One slice under agentFreeEnv(); titles are the executed "(pass)/(fail)"
 * lines, and a title count the summary cannot account for is refused. */
function runSlice(path: string): SliceRecord {
  const r = spawnSync("bun", ["test", "--path-ignore-patterns=**/dist/**", path], {
    cwd: REPO_ROOT,
    env: agentFreeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const parsed = parseBunTest(bunTestResultText(r), path);
  if (parsed.problem !== undefined) titleProblems.push(parsed.problem);
  return {
    exit: r.status ?? 1,
    pass: parsed.summary.pass ?? 0,
    fail: parsed.summary.fail ?? 0,
    ran: parsed.summary.ran ?? 0,
    baseline: BASELINE_PASS[path] ?? 0,
    failing: parsed.failTitles,
    titles: parsed.titles,
    reached_summary: parsed.summary.ran !== null,
  };
}

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx === -1 ? undefined : process.argv[outIdx + 1];

const titleProblems: string[] = [];
const origin: Record<string, SliceRecord> = {};
let bad = false;
for (const slice of ORIGIN_SLICES) {
  const rec = runSlice(slice);
  origin[slice] = rec;
  const drifted = rec.pass !== rec.baseline;
  if (rec.exit !== 0 || rec.fail > 0 || !rec.reached_summary || drifted) {
    bad = true;
    process.stdout.write(
      `section2-slice: ${slice} exit=${String(rec.exit)} pass=${String(rec.pass)} fail=${String(rec.fail)} baseline=${String(rec.baseline)}${drifted ? " DRIFT" : ""}${rec.reached_summary ? "" : " (no summary)"}\n`,
    );
  }
}

for (const p of titleProblems) {
  bad = true;
  process.stdout.write(`section2-slice: ${p}\n`);
}

const totals = {
  pass: Object.values(origin).reduce((a, s) => a + s.pass, 0),
  fail: Object.values(origin).reduce((a, s) => a + s.fail, 0),
  ran: Object.values(origin).reduce((a, s) => a + s.ran, 0),
};

const record = {
  origin,
  totals,
  baseline: BASELINE_PASS,
  package_dir: relative(REPO_ROOT, PACKAGE_DIR),
};

if (outPath !== undefined) {
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(record)}\n`);
process.stdout.write(
  `section2-slice: ${bad ? "FAIL" : "PASS"} (origin ${String(totals.pass)} pass / ${String(totals.fail)} fail over ${String(totals.ran)} tests)\n`,
);
process.exit(bad ? 1 : 0);
