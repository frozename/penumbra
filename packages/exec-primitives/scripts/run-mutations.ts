/**
 * run-mutations.ts — apply each mutation patch, run the package test suite,
 * record which tests detect the change, then revert.
 *
 * Usage: bun scripts/run-mutations.ts [--out <path>]
 * Prints a JSON array of mutation records to stdout (and --out file).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const MUTATIONS_DIR = join(PACKAGE_DIR, "qualification", "mutations");
// Package suite only — the leading ./ scopes path filters to test/ so consumer
// parity files under qualification/ are never picked up.
const TEST_GLOB = "./test/";

interface MutationMeta {
  intent: string;
  expectedDetectors: string[];
}

const MUTATION_META: Record<string, MutationMeta> = {
  "a-cancel-grace-sigkill.patch": {
    intent: "cancel kills the group with SIGKILL immediately, skipping SIGTERM",
    expectedDetectors: ["SIGTERM before escalating"],
  },
  "b-env-merge-ambient.patch": {
    intent: "spawn merges ambient process.env under the host env",
    expectedDetectors: ["leaks nothing", "exactly the host env keys"],
  },
  "c-request-open-guard.patch": {
    intent: "request() no longer rejects on a closed transport",
    expectedDetectors: ["closed transport rejects AcpTransportClosedError"],
  },
  "d-auth-retry-removed.patch": {
    intent: "session/new -32000 no longer triggers authenticate+retry",
    expectedDetectors: ["authenticates, and issues a single new-session retry"],
  },
  "e-pool-scope-dropped.patch": {
    intent: "poolKeyFor omits credentialScope from the key",
    expectedDetectors: ["never reused for scope B"],
  },
  "f-decide-throw-approve.patch": {
    intent: "a throwing decide maps to approve instead of reject",
    expectedDetectors: ["throwing decide selects reject_once"],
  },
};

function run(cmd: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}

function failingTests(output: string): string[] {
  const names = output
    .split("\n")
    .filter((line) => line.startsWith("(fail)"))
    .map((line) =>
      line
        .replace(/^\(fail\)\s+/, "")
        .replace(/\s*\[[\d.]+ms\]$/, "")
        .trim(),
    );
  return [...new Set(names)];
}

function countSummary(output: string): { pass: number; fail: number } {
  const m = /(\d+) pass\s*\n\s*(\d+) fail/.exec(output);
  if (m === null) return { pass: -1, fail: -1 };
  return { pass: Number(m[1]), fail: Number(m[2]) };
}

function main(): void {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx === -1 ? undefined : process.argv[outIdx + 1];
  const patches = readdirSync(MUTATIONS_DIR)
    .filter((f) => f.endsWith(".patch"))
    .sort();
  const records: unknown[] = [];

  for (const patch of patches) {
    const patchPath = join("packages/exec-primitives/qualification/mutations", patch);
    const meta = MUTATION_META[patch] ?? { intent: "", expectedDetectors: [] };

    const applied = run(["git", "apply", patchPath], REPO_ROOT);
    if (applied.code !== 0) {
      records.push({
        patch,
        intent: meta.intent,
        apply_error: applied.stderr.trim(),
        detected: false,
        failing_tests: [],
      });
      continue;
    }
    let testOut = "";
    let testCode = -1;
    try {
      const t = run(["bun", "test", TEST_GLOB], PACKAGE_DIR);
      testOut = `${t.stdout}\n${t.stderr}`;
      testCode = t.code;
    } finally {
      const reverted = run(["git", "apply", "-R", patchPath], REPO_ROOT);
      if (reverted.code !== 0) {
        run(["git", "checkout", "--", "packages/exec-primitives/src"], REPO_ROOT);
      }
    }

    const failing = failingTests(testOut);
    const counts = countSummary(testOut);
    const expectedHit = meta.expectedDetectors.every((d) => failing.some((f) => f.includes(d)));
    records.push({
      patch,
      intent: meta.intent,
      test_exit_code: testCode,
      pass: counts.pass,
      fail: counts.fail,
      failing_tests: failing,
      detected: failing.length > 0,
      expected_detectors: meta.expectedDetectors,
      expected_detectors_hit: expectedHit,
    });
  }

  const status = run(["git", "status", "--porcelain", "packages/exec-primitives/src"], REPO_ROOT);
  const result = {
    clean_after: status.stdout.trim().length === 0,
    mutations: records,
  };
  const json = JSON.stringify(result, null, 2);
  if (outPath !== undefined) {
    Bun.write(outPath, `${json}\n`);
  }
  process.stdout.write(`${json}\n`);
}

main();
