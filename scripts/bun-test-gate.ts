#!/usr/bin/env bun
/**
 * CI test gate that tolerates a known, version-independent Bun NAPI-teardown
 * panic without masking real failures.
 *
 * `bun test` exits 133 ("panic(main thread): A C++ exception occurred / Bun has
 * crashed") at PROCESS TEARDOWN — AFTER printing a clean summary — when an
 * embedding-model NAPI (fastembed) and the sqlite-vec extension co-reside in one
 * test process. This reproduces on both the canary and the latest stable bun
 * (1.3.14), so it is an upstream bun bug, not test-code. A bare `bun test` exit
 * code therefore reds the CI gate even when every test passes.
 *
 * This wrapper runs `bun test`, streams its output, and gates on the REPORTED
 * failure/error counts instead of the raw exit code. It exits 0 only when the run
 * reached its summary with 0 failures AND 0 errors AND the non-zero exit is the
 * known teardown panic. A real test failure (fail > 0), a load error (error > 0),
 * or any crash BEFORE the summary (no "Ran N tests" line) still fails the gate.
 */
import { spawnSync } from "node:child_process";

// Always exclude stale compiled test shadows in dist/ — the package tsconfigs are
// noEmit, so any packages/*/dist/test/*.test.js are leftover artifacts that bun
// would otherwise glob (failing on relative imports and inflating the count).
// bun accepts multiple --path-ignore-patterns flags, so caller-supplied patterns still apply.
const res = spawnSync(
  "bun",
  ["test", "--path-ignore-patterns=**/dist/**", ...process.argv.slice(2)],
  {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  },
);
const raw = res.stdout + res.stderr;
// Echo the child's output so CI logs are unchanged.
if (res.stdout) {
  process.stdout.write(res.stdout);
}
if (res.stderr) {
  process.stderr.write(res.stderr);
}

const code = res.status ?? 1;
if (code === 0) {
  process.exit(0);
}

// Build the ANSI-escape pattern from String.fromCharCode so the source does
// not contain a literal ESC control character (no-control-regex).
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const out = raw.replaceAll(ANSI_PATTERN, ""); // strip ANSI before parsing
const lastNum = (re: RegExp): number | null => {
  const matches = [...out.matchAll(re)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
};
const fails = lastNum(/(\d+)\s+fail\b/g);
const errors = lastNum(/(\d+)\s+error\b/g) ?? 0;
const reachedSummary = /Ran\s+\d+\s+tests?\b/.test(out);
const knownPanic = /Bun has crashed|panic\(main thread\)/.test(out);

if (reachedSummary && fails === 0 && errors === 0 && knownPanic) {
  console.error(
    `::warning:: bun test exited ${String(code)} via the known NAPI-teardown panic, but reported 0 failures / 0 errors across all suites — treating as pass. See scripts/bun-test-gate.ts.`,
  );
  process.exit(0);
}

console.error(
  `bun-test-gate: failing (exit ${String(code)}; fails=${String(fails)} errors=${String(errors)} reachedSummary=${String(reachedSummary)} knownPanic=${String(knownPanic)}).`,
);
process.exit(code);
