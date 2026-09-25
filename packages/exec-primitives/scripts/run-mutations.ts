/**
 * run-mutations.ts — apply each qualification mutation patch, run the package
 * test suite, verify the expected detector tests (and only those) fail, then
 * revert and confirm the suite is green again.
 *
 * Every record carries the full failing-tests set, collateral included —
 * mutations that shift allowlisted audit lines also trip the [B10] audit test.
 * The script exits non-zero on: a patch that applies outside src/, a suite
 * that stays green under the mutation, extra/missing failures versus the
 * expected detector set, a suite that never reaches its summary line, a
 * revert failure, or a dirty src tree afterwards.
 *
 * Usage: bun scripts/run-mutations.ts [--out <path>]
 */
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const MUTATIONS_DIR = join(PACKAGE_DIR, "qualification", "mutations");
// Package suite only — the leading ./ scopes path filters to test/ so consumer
// parity files under qualification/ are never picked up.
const TEST_GLOB = "./test/";
const SRC_PREFIX = "packages/exec-primitives/src/";

interface MutationMeta {
  /** Boundary tag the patch is designed to prove (must appear in ≥1 detector). */
  tag: string;
  intent: string;
  /** Exact full titles ("describe > test") expected to fail — collateral too. */
  expected: string[];
}

const MUTATION_META: Record<string, MutationMeta> = {
  "a-env-base.patch": {
    tag: "B3",
    intent: "spawn merges ambient process.env under the host env",
    expected: [
      "[B3] env boundary > [B3] runProcess passes the host env verbatim and leaks nothing",
      "[B3] env boundary > [B3] startStdioAcpServer child sees exactly the host env keys",
      "[B10] single-owner guarantees > [B10] the closure audit reports zero mutable module-scope bindings",
    ],
  },
  "b-digestless-key.patch": {
    tag: "B7",
    intent: "poolKeyFor omits credentialScope from the key",
    expected: [
      "[B7] warm pool > [B7] an entry pooled under credentialScope A is never reused for scope B",
      "[B7] warm pool > [B7] teardown kills exactly the deposited handles; a control process survives",
    ],
  },
  "c-unguarded-request.patch": {
    tag: "B8",
    intent: "request() no longer rejects on a closed transport",
    expected: [
      "[B8] closed transport > [B8] request() on a closed transport rejects AcpTransportClosedError within 50ms",
      "[B8] stream and handler faults > [B8] a synchronous write failure rejects the request and leaves no orphan",
      "[B10] single-owner guarantees > [B10] the closure audit reports zero mutable module-scope bindings",
    ],
  },
  "d-grace-default.patch": {
    tag: "B4",
    intent: "cancelGraceMs is replaced by the constant 10000",
    expected: [
      "[B4] cancel grace > [B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=300",
      "[B4] cancel grace > [B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=2500",
      "[B10] required host inputs > [B10] missing cancelGraceMs throws HostInputError before spawn",
      "[B10] cancel resolves the exit record only after the whole group is gone",
    ],
  },
  "e-hardcoded-clientinfo.patch": {
    tag: "B6",
    intent: "initialize advertises a literal clientInfo instead of the host's",
    expected: [
      "[B6] session bootstrap > [B6] initialize params carry the host clientInfo verbatim on the wire",
    ],
  },
  "f-watchdog-default.patch": {
    tag: "B4",
    intent: "watchdogMs is replaced by the constant 5000",
    expected: [
      "[B4] watchdog > [B4] watchdog fires inside (watchdogMs, watchdogMs+1500) at watchdogMs=400",
      "[B4] watchdog > [B4] watchdog fires inside (watchdogMs, watchdogMs+1500) at watchdogMs=2500",
      "[B10] required host inputs > [B10] missing watchdogMs throws HostInputError before spawn",
      "[B10] injected timers are fully disarmed by the time exit resolves on every outcome",
      "[B10] a leader exit with a detached descendant still resolves under the watchdog",
      "[B10] a throwing onProcessEvent observer cannot defuse the watchdog and exit still settles",
    ],
  },
};

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cmd: string[], cwd: string): CmdResult {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}

const problems: string[] = [];

function fail(problem: string): void {
  problems.push(problem);
}

/** Whole-line `(fail) <title> [X.XXms]` lines — deduped (bun prints them twice). */
function failingTitles(output: string): string[] {
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const t = line.trimEnd();
    if (!t.startsWith("(fail) ")) continue;
    const title = t.slice("(fail) ".length).replace(/ \[[\d.]+m?s\]$/, "");
    if (title !== "") seen.add(title);
  }
  return [...seen].sort();
}

function summaryCounts(output: string): { pass: number; fail: number; ran: number } | null {
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  const ran = /^\s*Ran (\d+) tests\b/m.exec(output)?.[1];
  if (pass === undefined || fail === undefined || ran === undefined) return null;
  return { pass: Number(pass), fail: Number(fail), ran: Number(ran) };
}

interface SuiteRun {
  output: string;
  code: number;
  counts: { pass: number; fail: number; ran: number } | null;
  failing: string[];
}

function runSuite(): SuiteRun {
  const t = run(["bun", "test", TEST_GLOB], PACKAGE_DIR);
  const output = `${t.stdout}\n${t.stderr}`;
  return { output, code: t.code, counts: summaryCounts(output), failing: failingTitles(output) };
}

/** Escape a literal title into a whole-line (fail) regex. */
function titleLine(title: string): RegExp {
  const esc = title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\(fail\\) ${esc}( \\[[0-9.]+m?s\\])?$`, "m");
}

function numstatPaths(patchPath: string): string[] {
  const r = run(["git", "apply", "--numstat", patchPath], REPO_ROOT);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/).at(-1) ?? "");
}

function srcClean(): boolean {
  const status = run(["git", "status", "--porcelain", "packages/exec-primitives/src"], REPO_ROOT);
  return status.stdout.trim().length === 0;
}

function greenSuite(label: string): boolean {
  const g = runSuite();
  if (g.code !== 0 || g.counts?.fail !== 0) {
    fail(`${label}: suite not green (exit=${String(g.code)}, counts=${JSON.stringify(g.counts)})`);
    return false;
  }
  return true;
}

/** Apply patch, run the suite mutated, revert, confirm post-revert green. */
function exercisePatch(patch: string, relPatchPath: string): { run?: SuiteRun; green: boolean } {
  const applied = run(["git", "apply", relPatchPath], REPO_ROOT);
  if (applied.code !== 0) {
    fail(`${patch}: git apply failed: ${applied.stderr.trim()}`);
    return { green: false };
  }
  let mutated: SuiteRun | undefined;
  try {
    mutated = runSuite();
  } finally {
    const reverted = run(["git", "apply", "-R", relPatchPath], REPO_ROOT);
    if (reverted.code !== 0) {
      fail(`${patch}: git apply -R failed: ${reverted.stderr.trim()}`);
    }
  }
  return { run: mutated, green: greenSuite(`${patch} post-revert`) };
}

function patchProblems(patch: string, meta: MutationMeta, mutated: SuiteRun | undefined): string[] {
  const out: string[] = [];
  if (mutated === undefined) return ["suite never ran under the mutation"];
  if (mutated.counts === null) {
    out.push("suite never reached its summary line (load error?)");
  } else {
    if (mutated.counts.fail !== mutated.failing.length) {
      out.push(
        `summary fail=${String(mutated.counts.fail)} vs parsed failing=${String(mutated.failing.length)}`,
      );
    }
    if (mutated.counts.pass + mutated.counts.fail !== mutated.counts.ran) {
      out.push(
        `summary pass+fail ${String(mutated.counts.pass + mutated.counts.fail)} != ran ${String(mutated.counts.ran)}`,
      );
    }
  }
  if (mutated.failing.length === 0) {
    out.push("suite stayed green under the mutation — undetected");
  }
  for (const title of meta.expected) {
    if (!titleLine(title).test(mutated.output)) {
      out.push(`expected detector did not fail: ${title}`);
    }
  }
  const expectedSet = new Set(meta.expected);
  const unexpected = mutated.failing.filter((f) => !expectedSet.has(f));
  if (unexpected.length > 0) {
    out.push(`unexpected failures: ${JSON.stringify(unexpected)}`);
  }
  if (!meta.expected.some((t) => t.includes(`[${meta.tag}]`))) {
    out.push(`no expected detector carries tag [${meta.tag}]`);
  }
  return out;
}

function mutationRecord(
  patch: string,
  meta: MutationMeta,
  paths: string[],
  mutated: SuiteRun | undefined,
  postGreen: boolean,
  patchIssues: string[],
): Record<string, unknown> {
  const expectedSet = new Set(meta.expected);
  const unexpected = mutated?.failing.filter((f) => !expectedSet.has(f)) ?? [];
  return {
    mutation: patch.replace(/\.patch$/, ""),
    patch,
    intent: meta.intent,
    tag: meta.tag,
    numstat_paths: paths,
    test_exit_code: mutated?.code ?? null,
    pass: mutated?.counts?.pass ?? null,
    fail: mutated?.counts?.fail ?? null,
    ran: mutated?.counts?.ran ?? null,
    failing_tests: mutated?.failing ?? [],
    expected_detectors: meta.expected,
    expected_detectors_hit:
      mutated !== undefined && meta.expected.every((t) => titleLine(t).test(mutated.output)),
    detected:
      (mutated?.failing.length ?? 0) > 0 &&
      unexpected.length === 0 &&
      mutated !== undefined &&
      meta.expected.every((t) => titleLine(t).test(mutated.output)),
    post_revert_green: postGreen,
    exit: patchIssues.length === 0 ? 0 : 1,
  };
}

function main(): void {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx === -1 ? undefined : process.argv[outIdx + 1];
  const patches = readdirSync(MUTATIONS_DIR)
    .filter((f) => f.endsWith(".patch"))
    .sort();
  const records: unknown[] = [];

  for (const patch of patches) {
    const meta = MUTATION_META[patch];
    if (meta === undefined) {
      fail(`${patch}: no measured expectation — unmeasured mutation entry`);
      continue;
    }
    const relPatchPath = join("packages/exec-primitives/qualification/mutations", patch);

    const paths = numstatPaths(relPatchPath);
    if (paths.length === 0 || paths.length > 3 || paths.some((p) => !p.startsWith(SRC_PREFIX))) {
      fail(`${patch}: numstat paths out of scope: ${JSON.stringify(paths)}`);
      continue;
    }

    const { run: mutated, green: postGreen } = exercisePatch(patch, relPatchPath);
    const patchIssues = patchProblems(patch, meta, mutated);
    if (!postGreen) patchIssues.push("suite not green after revert");
    for (const p of patchIssues) fail(`${patch}: ${p}`);
    records.push(mutationRecord(patch, meta, paths, mutated, postGreen, patchIssues));
  }

  const cleanAfter = srcClean();
  if (!cleanAfter) fail("src tree dirty after all reverts");
  const result = { clean_after: cleanAfter, mutations: records };
  const json = JSON.stringify(result, null, 2);
  if (outPath !== undefined) {
    writeFileSync(outPath, `${json}\n`);
  }
  process.stdout.write(`${json}\n`);
  if (problems.length > 0) {
    process.stderr.write(`run-mutations: FAIL\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("run-mutations: PASS\n");
}

main();
