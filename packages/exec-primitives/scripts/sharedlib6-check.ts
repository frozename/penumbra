#!/usr/bin/env bun
/**
 * sharedlib6-check.ts — composite qualification gate for the extracted
 * penumbra-exec-primitives package. This is the ONLY authoritative verdict
 * for the sharedlib6 qualification task.
 *
 * Flow:
 *   1. rm -rf tmp/sharedlib6 (fresh scratch space for every run)
 *   2. hard preconditions — closure, parser and fence self-tests, origin
 *      remote, merge-base ancestors, frozen-lockfile install, clean worktree. Any failure aborts
 *      before artifacts are written.
 *   3. fourteen ordered steps (below). Every step runs even when an earlier
 *      one failed; one line per step is printed. The fence runs AFTER qualify
 *      and the tarball audit so it observes the tree the way the composite
 *      will leave it.
 *   4. SHAPE (sharedlib6-shape.ts) — the committed .json must equal the
 *      record the evidence writer's builder produces from this run (a short
 *      list of exempt fields is bound by range or recorded as environment),
 *      the committed .md must equal the render of the committed .json, and
 *      the contract rules must hold. Self-test probes then edit clones of the
 *      committed pair (counts, claim text, blockers, deviations, honesty, a
 *      .md cell) and each must turn SHAPE red.
 *   5. SHAREDLIB6-CHECK PASS, or SHAREDLIB6-CHECK FAIL listing every failing
 *      step (plus SHAPE). There is no sidecar verdict file; nothing
 *      downstream of a failed step is allowed to stand in for a real verdict.
 *
 * Unless --keep is passed, tmp/sharedlib6 is removed at the end of the run.
 * The tracked tree stays byte-clean: consumers run as copies, generated
 * contract tests live only inside the tmp copy, and no generated artifact is
 * ever written under qualification/.
 *
 * Usage: bun scripts/sharedlib6-check.ts [--keep]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agentFreeEnv, bunTestSummary } from "./bun-test-parse.js";
import { fenceReasons } from "./sharedlib6-fence.js";
import { BASE_SHA, type GateRec, readJsonFile, rec } from "./sharedlib6-shape-util.js";
import { buildShapeContext, runShape } from "./sharedlib6-shape.js";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const LOG_DIR = join(RUN_DIR, "check-logs");
const KEEP = process.argv.includes("--keep");

const REQUIRED_ANCESTORS = [BASE_SHA, "a338eb8e3", "e634f10db87e0f36a14338356e1887cfbf58c83d"];
const MEASUREMENTS = join(RUN_DIR, "measurements.json");
const MUTATIONS_JSON = join(RUN_DIR, "mutations.json");
const SECTION2_JSON = join(RUN_DIR, "section2.json");

interface CmdOut {
  exit: number;
  output: string;
}

function run(argv: string[], cwd: string, env?: NodeJS.ProcessEnv): CmdOut {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new Error("run: empty argv");
  const r = spawnSync(bin, args, {
    cwd,
    // Output-format keys are stripped for every step: bun test hides or
    // reshapes its "(pass)" lines under CLAUDECODE/AGENT/REPL_ID/FORCE_COLOR
    // (bun-test-parse.ts).
    env: env ?? agentFreeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 900_000,
  });
  const output = `${r.stdout}${r.stderr}`;
  if (r.error !== undefined) {
    return { exit: 1, output: `${output}spawn error: ${String(r.error)}` };
  }
  return { exit: r.status ?? 1, output };
}

function runLogged(argv: string[], cwd: string, logName: string, env?: NodeJS.ProcessEnv): CmdOut {
  const r = run(argv, cwd, env);
  writeFileSync(join(LOG_DIR, `check-${logName}.log`), r.output);
  return r;
}

function git(args: string[]): CmdOut {
  return run(["git", ...args], REPO_ROOT);
}

function counts(output: string): { pass: number | null; fail: number | null } {
  const { pass, fail } = bunTestSummary(output);
  return { pass, fail };
}

// ---------------------------------------------------------------------------
// 1. fresh scratch space
// ---------------------------------------------------------------------------
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 2. hard preconditions — abort before any artifact is written
// ---------------------------------------------------------------------------
const precheckFailures: string[] = [];

const selfTest = runLogged(
  ["bun", "scripts/closure-audit.ts", "--self-test"],
  PACKAGE_DIR,
  "precheck-closure-self-test",
);
if (selfTest.exit !== 0) precheckFailures.push("closure-audit --self-test");

const parseSelfTest = runLogged(
  ["bun", "scripts/bun-test-parse.ts", "--self-test"],
  PACKAGE_DIR,
  "precheck-bun-test-parse-self-test",
);
if (parseSelfTest.exit !== 0) precheckFailures.push("bun-test-parse --self-test");

const fenceSelfTest = runLogged(
  ["bun", "scripts/sharedlib6-fence.ts", "--self-test"],
  PACKAGE_DIR,
  "precheck-fence-self-test",
);
if (fenceSelfTest.exit !== 0) precheckFailures.push("sharedlib6-fence --self-test");

const remote = git(["remote", "get-url", "origin"]);
if (remote.exit !== 0 || !remote.output.includes("frozename/penumbra")) {
  precheckFailures.push(`origin remote (${remote.output.trim()})`);
}

for (const ancestor of REQUIRED_ANCESTORS) {
  const anc = git(["merge-base", "--is-ancestor", ancestor, "HEAD"]);
  if (anc.exit !== 0) precheckFailures.push(`not an ancestor: ${ancestor}`);
}

const install = runLogged(
  ["bun", "install", "--frozen-lockfile"],
  REPO_ROOT,
  "precheck-bun-install",
);
if (install.exit !== 0) precheckFailures.push("bun install --frozen-lockfile");

const porcelain = git(["status", "--porcelain"]);
if (porcelain.exit !== 0 || porcelain.output.trim() !== "") {
  precheckFailures.push("git status --porcelain not empty");
}

if (precheckFailures.length > 0) {
  process.stdout.write(`PRECHECK FAIL: ${precheckFailures.join(", ")}\n`);
  if (!KEEP) rmSync(RUN_DIR, { recursive: true, force: true });
  process.exit(1);
}
process.stdout.write("prechecks: PASS\n");

// ---------------------------------------------------------------------------
// 3. ordered steps — all run; failures accumulate
// ---------------------------------------------------------------------------
const gates: GateRec[] = [];

function recordGate(gate: string, outs: CmdOut[], logNames: string[], gating = true): void {
  const exit = outs.some((o) => o.exit !== 0) ? 1 : 0;
  let pass: number | null = null;
  let fail: number | null = null;
  for (const o of outs) {
    const c = counts(o.output);
    if (c.pass !== null) pass = (pass ?? 0) + c.pass;
    if (c.fail !== null) fail = (fail ?? 0) + c.fail;
  }
  gates.push({
    gate,
    exit,
    pass,
    fail,
    log: logNames.map((n) => `check-logs/check-${n}.log`).join(","),
    gating,
  });
}

const R = REPO_ROOT;
const P = PACKAGE_DIR;

// 1. root typecheck (also runs dist-freshness scrub + tsc --build)
recordGate("typecheck", [runLogged(["bun", "run", "typecheck"], R, "typecheck")], ["typecheck"]);

// 2. dist freshness, strict
recordGate(
  "dist-freshness",
  [
    runLogged(
      ["bun", "scripts/check-dist-freshness.ts"],
      R,
      "dist-freshness",
      agentFreeEnv({ DIST_CHECK_STRICT: "1" }),
    ),
  ],
  ["dist-freshness"],
);

// 3. typecheck coverage — repo ratchet (exec-primitives floor: 0 errors) plus
// the package file-coverage gate (every .ts inside a compiled project)
recordGate(
  "typecheck-coverage",
  [
    runLogged(["bun", "scripts/check-typecheck-coverage.ts"], R, "typecheck-coverage-ratchet"),
    runLogged(["bun", "scripts/check-typecheck-coverage.ts"], P, "typecheck-coverage-files"),
  ],
  ["typecheck-coverage-ratchet", "typecheck-coverage-files"],
);

// 4. raw-env + sync-exec lint guards
recordGate(
  "lint-guards",
  [
    runLogged(["bun", "run", "lint:no-raw-env"], R, "lint-no-raw-env"),
    runLogged(["bun", "run", "lint:no-sync-exec"], R, "lint-no-sync-exec"),
  ],
  ["lint-no-raw-env", "lint-no-sync-exec"],
);

// 5. eslint over the package surface
recordGate(
  "eslint",
  [
    runLogged(
      [
        "bunx",
        "eslint",
        "packages/exec-primitives/src",
        "packages/exec-primitives/test",
        "packages/exec-primitives/scripts",
        "--max-warnings=0",
      ],
      R,
      "eslint",
      agentFreeEnv({ NODE_OPTIONS: "--max-old-space-size=8192" }),
    ),
  ],
  ["eslint"],
);

// 6. prettier
recordGate(
  "prettier",
  [runLogged(["bunx", "prettier", "--check", "packages/exec-primitives"], R, "prettier")],
  ["prettier"],
);

// 7. package tests + suite-tag discipline
recordGate(
  "test-gate",
  [
    runLogged(["bun", "scripts/bun-test-gate.ts", "packages/exec-primitives"], R, "bun-test-gate"),
    runLogged(["bun", "scripts/check-suite-tags.ts"], P, "suite-tags"),
  ],
  ["bun-test-gate", "suite-tags"],
);

// 8. mutation loop
recordGate(
  "mutations",
  [runLogged(["bun", "scripts/run-mutations.ts", "--out", MUTATIONS_JSON], P, "mutations")],
  ["mutations"],
);

// 9. section-2 baseline slice (origin adapter suites + test/cli)
recordGate(
  "section2-slice",
  [runLogged(["bun", "scripts/section2-slice.ts", "--out", SECTION2_JSON], P, "section2-slice")],
  ["section2-slice"],
);

// 10. closure audit on source + consumer fixtures
recordGate(
  "closure-audit-src",
  [runLogged(["bun", "scripts/closure-audit.ts", "--src", "--consumers"], P, "closure-audit-src")],
  ["closure-audit-src"],
);

// 11. tarball qualification (pack, copy, install, run, measurements.json)
recordGate("qualify", [runLogged(["bun", "scripts/qualify.ts"], P, "qualify")], ["qualify"]);

// 12. closure audit on the packed+extracted tarball
recordGate(
  "closure-audit-tarball",
  [
    runLogged(
      ["bun", "scripts/closure-audit.ts", "--tarball", join(RUN_DIR, "pack", "extracted")],
      P,
      "closure-audit-tarball",
    ),
  ],
  ["closure-audit-tarball"],
);

// 13. fence — the contract allowlist over every changed path (plus the one
// tsconfig reference and the one ratchet entry), the composite's own path
// list, and both porcelain sweeps; runs after qualify and the tarball audit so
// nothing the run generated can hide.
{
  const show = (rev: string, path: string): string | null => {
    const r = git(["show", `${rev}:${path}`]);
    return r.exit === 0 ? r.output : null;
  };
  const nameDiff = git(["diff", "--name-only", BASE_SHA, "HEAD"]);
  const allowlist =
    nameDiff.exit === 0
      ? fenceReasons({
          names: nameDiff.output.split("\n").map((l) => l.trim()),
          tsconfigBase: show(BASE_SHA, "tsconfig.json"),
          tsconfigHead: show("HEAD", "tsconfig.json"),
          ratchetBase: show(BASE_SHA, "typecheck-coverage-ratchet.json"),
          ratchetHead: show("HEAD", "typecheck-coverage-ratchet.json"),
        })
      : [`git diff --name-only exited ${String(nameDiff.exit)}`];
  const adapterDiff = git([
    "diff",
    "--stat",
    BASE_SHA,
    "HEAD",
    "--",
    "packages/agentchat",
    "eslint.config.mjs",
    ".github",
    "scripts",
    "package.json",
    ".gitignore",
    "bunfig.toml",
  ]);
  const status = git(["status", "--porcelain"]);
  const qualStatus = git([
    "status",
    "--porcelain",
    "--ignored",
    "--",
    "packages/exec-primitives/qualification",
  ]);
  const output = `allowlist:\n${allowlist.join("\n")}\npath-diff:\n${adapterDiff.output}\nporcelain:\n${status.output}\nqualification-ignored:\n${qualStatus.output}`;
  writeFileSync(join(LOG_DIR, "check-fence.log"), output);
  const clean =
    allowlist.length === 0 &&
    adapterDiff.output.trim() === "" &&
    status.output.trim() === "" &&
    qualStatus.output.trim() === "";
  recordGate("fence", [{ exit: clean ? 0 : 1, output }], ["fence"]);
}

// 14. root lint — recorded, non-gating
recordGate("root-lint", [runLogged(["bun", "run", "lint"], R, "root-lint")], ["root-lint"], false);

for (const [i, g] of gates.entries()) {
  const countsStr = g.pass === null ? "" : ` ${String(g.pass)}p/${String(g.fail ?? "?")}f`;
  const flag = g.gating ? "" : " (non-gating)";
  process.stdout.write(
    `step ${String(i + 1).padStart(2, "0")} ${g.gate}: exit=${String(g.exit)}${countsStr}${flag}\n`,
  );
}

// check_steps live under their own key — never inside evidence.gates[], which
// holds only the six L1..L6 verdict objects.
if (existsSync(MEASUREMENTS)) {
  const existing = rec(readJsonFile(MEASUREMENTS));
  if (existing !== undefined) {
    existing["check_steps"] = gates;
    writeFileSync(MEASUREMENTS, `${JSON.stringify(existing, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// 4. SHAPE — committed evidence vs this run's measurements
// ---------------------------------------------------------------------------
const shapeReasons = runShape(buildShapeContext(REPO_ROOT, PACKAGE_DIR, gates, git));
if (shapeReasons.length === 0) {
  process.stdout.write("SHAPE PASS\n");
} else {
  for (const r of shapeReasons) process.stdout.write(`SHAPE FAIL: ${r}\n`);
}

// ---------------------------------------------------------------------------
// 5. verdict + cleanup
// ---------------------------------------------------------------------------
const failedGates = gates.filter((g) => g.gating && g.exit !== 0).map((g) => g.gate);
const result = failedGates.length === 0 && shapeReasons.length === 0 ? "PASS" : "FAIL";

writeFileSync(
  join(RUN_DIR, "check.json"),
  `${JSON.stringify(
    {
      finished_at: new Date().toISOString(),
      check_steps: gates,
      shape: shapeReasons,
      result,
    },
    null,
    2,
  )}\n`,
);

if (result === "PASS") {
  process.stdout.write("SHAREDLIB6-CHECK PASS\n");
} else {
  const parts = [...failedGates];
  if (shapeReasons.length > 0) parts.push("SHAPE");
  process.stdout.write(`SHAREDLIB6-CHECK FAIL: ${parts.join(", ")}\n`);
}

if (!KEEP) rmSync(RUN_DIR, { recursive: true, force: true });
process.exit(result === "PASS" ? 0 : 1);
