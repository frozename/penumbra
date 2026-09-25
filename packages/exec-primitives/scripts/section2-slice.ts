#!/usr/bin/env bun
/**
 * section2-slice.ts — measure the section-2 baseline: the retained
 * packages/agentchat adapter test files the extraction drew from, run in
 * place against the unmodified origin sources, plus the
 * packages/agentchat/test/cli context slice.
 *
 * Writes tmp/sharedlib6/section2.json with per-file pass/fail counts and the
 * failing test names — the evidence's section-2 block and the shape
 * validator both compare against this record, so it records measured truth
 * rather than asserting a canned baseline.
 *
 * Usage: bun scripts/section2-slice.ts --out <path>
 * Exits 0 when every slice ran to a summary; exits 1 when any slice fails,
 * errors, or never reaches its "Ran N tests" line.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

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

interface SliceRecord {
  exit: number;
  pass: number;
  fail: number;
  ran: number;
  failing: string[];
  reached_summary: boolean;
}

function runSlice(path: string): SliceRecord {
  const r = spawnSync("bun", ["test", "--path-ignore-patterns=**/dist/**", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const output = `${r.stdout}${r.stderr}`;
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  const ran = /^\s*Ran (\d+) tests\b/m.exec(output)?.[1];
  const failing = [...output.matchAll(/^\(fail\) (.+)$/gm)]
    .map((m) => (m[1] ?? "").replace(/ \[[\d.]+m?s\]$/, ""))
    .filter((t) => t !== "")
    .sort();
  return {
    exit: r.status ?? 1,
    pass: pass === undefined ? 0 : Number(pass),
    fail: fail === undefined ? 0 : Number(fail),
    ran: ran === undefined ? 0 : Number(ran),
    failing,
    reached_summary: ran !== undefined,
  };
}

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx === -1 ? undefined : process.argv[outIdx + 1];

const origin: Record<string, SliceRecord> = {};
let bad = false;
for (const slice of ORIGIN_SLICES) {
  const rec = runSlice(slice);
  origin[slice] = rec;
  if (rec.exit !== 0 || rec.fail > 0 || !rec.reached_summary) {
    bad = true;
    process.stdout.write(
      `section2-slice: ${slice} exit=${String(rec.exit)} pass=${String(rec.pass)} fail=${String(rec.fail)}${rec.reached_summary ? "" : " (no summary)"}\n`,
    );
  }
}

const totals = {
  pass: Object.values(origin).reduce((a, s) => a + s.pass, 0),
  fail: Object.values(origin).reduce((a, s) => a + s.fail, 0),
  ran: Object.values(origin).reduce((a, s) => a + s.ran, 0),
};

const record = {
  origin,
  totals,
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
