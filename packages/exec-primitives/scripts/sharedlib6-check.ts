#!/usr/bin/env bun
/**
 * sharedlib6-check.ts — composite qualification gate for the extracted
 * penumbra-exec-primitives package. This is the ONLY authoritative verdict
 * for the sharedlib6 qualification task.
 *
 * Flow:
 *   1. rm -rf tmp/sharedlib6 (fresh scratch space for every run)
 *   2. hard preconditions — closure self-test, origin remote, merge-base
 *      ancestors, frozen-lockfile install, clean worktree. Any failure aborts
 *      before artifacts are written.
 *   3. fourteen ordered steps (below). Every step runs even when an earlier
 *      one failed; one line per step is printed. The fence runs AFTER qualify
 *      and the tarball audit so it observes the tree the way the composite
 *      will leave it.
 *   4. SHAPE — the committed evidence pair must be internally consistent and
 *      must match this run's fresh measurements field-for-field. Missing,
 *      malformed, stale, or inconsistent evidence is a failure.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agentFreeEnv } from "./bun-test-parse.js";
import {
  shapeCheckSteps,
  shapeConsumers,
  shapeMutations,
  shapeParity,
  shapeSection2,
  shapeTarball,
  shapeVerdicts,
} from "./sharedlib6-shape-measured.js";
import {
  claimRe,
  FORBIDDEN_CLAIMS,
  type GateRec,
  NPH_LITERALS,
  readJsonFile,
  rec,
  REQUIRED_BLOCKERS,
  type ShapeContext,
  str,
} from "./sharedlib6-shape-util.js";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const LOG_DIR = join(RUN_DIR, "check-logs");
const KEEP = process.argv.includes("--keep");

const BASE_SHA = "c264644bc2b4f1e1429e845208fd6ca7f6426d62";
const REQUIRED_ANCESTORS = [BASE_SHA, "a338eb8e3", "e634f10db87e0f36a14338356e1887cfbf58c83d"];
const EVIDENCE_DATE = "2026-09-24";
const EVIDENCE_JSON = join(
  REPO_ROOT,
  "docs",
  "qualification",
  `${EVIDENCE_DATE}-sharedlib6-qualification.json`,
);
const EVIDENCE_MD = join(
  REPO_ROOT,
  "docs",
  "qualification",
  `${EVIDENCE_DATE}-sharedlib6-qualification.md`,
);
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
    // Agent-mode keys are stripped for every step: bun test hides its
    // "(pass)" lines under CLAUDECODE/AGENT/REPL_ID (bun-test-parse.ts).
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
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  return {
    pass: pass === undefined ? null : Number(pass),
    fail: fail === undefined ? null : Number(fail),
  };
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

// 13. fence — the composite's own path list plus both porcelain sweeps; runs
// after qualify and the tarball audit so nothing the run generated can hide.
{
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
  const output = `path-diff:\n${adapterDiff.output}\nporcelain:\n${status.output}\nqualification-ignored:\n${qualStatus.output}`;
  writeFileSync(join(LOG_DIR, "check-fence.log"), output);
  const clean =
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
const shapeCtx: ShapeContext = {
  repoRoot: REPO_ROOT,
  packageDir: PACKAGE_DIR,
  runDir: RUN_DIR,
  logDir: LOG_DIR,
  evidenceJson: EVIDENCE_JSON,
  evidenceMd: EVIDENCE_MD,
  measurements: MEASUREMENTS,
  mutations: MUTATIONS_JSON,
  section2: SECTION2_JSON,
  baseSha: BASE_SHA,
  gates,
  git,
};

function shapeHeadSha(ctx: ShapeContext, evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (evidence["base_sha"] !== ctx.baseSha) reasons.push("evidence base_sha != required base");
  const headSha = str(evidence["head_sha"]);
  if (headSha === "") {
    reasons.push("evidence head_sha missing");
    return reasons;
  }
  if (ctx.git(["cat-file", "-e", headSha]).exit !== 0) {
    reasons.push(`evidence head_sha ${headSha} is not a commit`);
    return reasons;
  }
  const listed = ctx
    .git(["rev-list", `${ctx.baseSha}..HEAD`])
    .output.split("\n")
    .map((l) => l.trim());
  if (!listed.includes(headSha)) {
    reasons.push("evidence head_sha is not a commit between base and HEAD");
  }
  return reasons;
}

function shapeHonestyAndClaims(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const honesty = rec(evidence["honesty"]);
  if (
    honesty?.["channel_stand_in"] !== true ||
    honesty["channel_chosen"] !== false ||
    honesty["home_chosen"] !== false ||
    honesty["adoption_performed"] !== false ||
    honesty["overall_claim"] !== "none"
  ) {
    reasons.push("honesty fields missing or wrong");
  }
  if (!deepEqualLocal(evidence["claims_not_made"], FORBIDDEN_CLAIMS)) {
    reasons.push("claims_not_made does not list exactly the required claims");
  }
  const deviations = evidence["deviations"];
  if (
    !Array.isArray(deviations) ||
    deviations.some((d) => {
      const r = rec(d);
      return (
        r === undefined || ["rule", "change", "reason", "pointer"].some((k) => str(r[k]) === "")
      );
    })
  ) {
    reasons.push("deviations[] entries must all carry non-empty rule/change/reason/pointer");
  }
  return reasons;
}

function deepEqualLocal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function gateEvidenceShape(g: Record<string, unknown>, idx: number): string[] {
  const reasons: string[] = [];
  const label = `L${String(idx + 1)}`;
  if (g["gate"] !== label) reasons.push(`gate ${String(idx + 1)} is not ${label}`);
  if (g["scope"] !== "branch") reasons.push(`${label} scope != branch`);
  if (!["PASS", "FAIL", "DEFERRED"].includes(str(g["verdict"]))) {
    reasons.push(`${label} verdict invalid`);
  }
  const nph = g["not_provable_here"];
  if (!Array.isArray(nph) || nph.length === 0 || nph.some((s) => typeof s !== "string")) {
    reasons.push(`${label} not_provable_here missing or empty`);
  } else {
    for (const lit of NPH_LITERALS[idx + 1] ?? []) {
      if (!nph.some((s) => String(s).includes(lit))) {
        reasons.push(`${label} not_provable_here missing literal "${lit}"`);
      }
    }
  }
  const ev = g["evidence"];
  if (
    !Array.isArray(ev) ||
    ev.length === 0 ||
    ev.some((e) => {
      const er = rec(e);
      return (
        er === undefined ||
        !["confirmed", "inferred"].includes(str(er["status"])) ||
        str(er["pointer"]) === "" ||
        str(er["claim"]) === ""
      );
    })
  ) {
    reasons.push(`${label} evidence[] malformed`);
  }
  return reasons;
}

function shapeL3(g: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (g["verdict"] === "PASS") reasons.push("L3 must never be PASS");
  const parts = rec(g["parts"]);
  if (
    !["PASS", "FAIL"].includes(str(parts?.["penumbra"])) ||
    !["PASS", "FAIL"].includes(str(parts?.["synthetic"])) ||
    parts?.["llamactl"] !== "DEFERRED"
  ) {
    reasons.push("L3 parts malformed");
  }
  if (g["deferred_to"] !== "P2.2/llamactl-adoption") {
    reasons.push("L3 deferred_to wrong");
  }
  if (
    g["verdict"] === "DEFERRED" &&
    (parts?.["penumbra"] !== "PASS" || parts["synthetic"] !== "PASS")
  ) {
    reasons.push("L3 DEFERRED needs both parts PASS");
  }
  return reasons;
}

function shapeGates(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const evGates = evidence["gates"];
  if (!Array.isArray(evGates) || evGates.length !== 6) {
    reasons.push("evidence gates[] must be exactly six L1..L6 entries");
    return reasons;
  }
  for (const [i, g] of evGates.entries()) {
    reasons.push(...gateEvidenceShape(rec(g) ?? {}, i));
  }
  if (rec(evGates[1])?.["verdict_scope"] !== "stand-in") {
    reasons.push("L2 verdict_scope != stand-in");
  }
  reasons.push(...shapeL3(rec(evGates[2]) ?? {}));
  for (const [i, g] of evGates.entries()) {
    if (i !== 2 && rec(g)?.["verdict"] === "DEFERRED") {
      reasons.push(`DEFERRED appears on gate ${String(i + 1)}`);
    }
  }
  return reasons;
}

function blockerIndex(evidence: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const bl: Record<string, Record<string, unknown>> = {};
  const raw = evidence["blockers"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const er = rec(entry);
      const id = str(er?.["id"] ?? er?.["blocker"]);
      if (id !== "") bl[id] = er ?? {};
    }
  } else {
    for (const [k, v] of Object.entries(rec(raw) ?? {})) {
      const er = rec(v);
      if (er !== undefined) bl[k] = er;
    }
  }
  return bl;
}

function blockerVerdictReasons(
  evidence: Record<string, unknown>,
  bl: Record<string, Record<string, unknown>>,
): string[] {
  const reasons: string[] = [];
  const verdict = (i: number): string => {
    const gatesArr = evidence["gates"];
    return Array.isArray(gatesArr) ? str(rec(gatesArr[i])?.["verdict"]) : "";
  };
  const statusOf = (id: string): string => str(bl[id]?.["status"]);
  if (verdict(1) === "PASS" && statusOf("B1") !== "resolved") {
    reasons.push("L2 PASS needs B1 resolved");
  }
  if (
    verdict(3) === "PASS" &&
    ["B3", "B4", "B6", "B7", "B10"].some((k) => statusOf(k) !== "resolved")
  ) {
    reasons.push("L4 PASS needs B3 B4 B6 B7 B10 resolved");
  }
  if (verdict(5) === "PASS" && statusOf("B7") !== "resolved") {
    reasons.push("L6 PASS needs B7 resolved");
  }
  return reasons;
}

function shapeBlockers(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const bl = blockerIndex(evidence);
  for (const id of REQUIRED_BLOCKERS) {
    const status = str(bl[id]?.["status"]);
    if (!["resolved", "disproved", "open"].includes(status)) {
      reasons.push(`blocker ${id} status invalid or missing`);
    }
  }
  reasons.push(...blockerVerdictReasons(evidence, bl));
  return reasons;
}

function claimsSectionReasons(md: string): string[] {
  const reasons: string[] = [];
  const sectionRe = /## Claims not made\n([\s\S]*?)(?=\n## |\n?$)/;
  const section = sectionRe.exec(md)?.[1] ?? "";
  const rest = md.replace(sectionRe, "");
  for (const claim of FORBIDDEN_CLAIMS) {
    if (!section.includes(claim)) {
      reasons.push(`claims section missing: ${claim}`);
    }
    if (claimRe(claim).test(rest)) {
      reasons.push(`claim "${claim}" appears outside the Claims-not-made section`);
    }
  }
  return reasons;
}

function shapeForbiddenClaims(ctx: ShapeContext): string[] {
  const reasons: string[] = [];
  const readme = readFileSync(join(ctx.packageDir, "README.md"), "utf8");
  const manifestText = ["penumbra-host", "infra-host"]
    .map((n) =>
      readFileSync(join(ctx.packageDir, "qualification", "consumers", n, "package.json"), "utf8"),
    )
    .join("\n");
  const gitLog = ctx.git(["log", `${ctx.baseSha}..HEAD`, "--format=%B"]).output;
  for (const claim of FORBIDDEN_CLAIMS) {
    const re = claimRe(claim);
    if (re.test(readme)) reasons.push(`README contains forbidden claim: ${claim}`);
    if (re.test(manifestText)) reasons.push(`consumer manifest contains forbidden claim: ${claim}`);
    if (re.test(gitLog)) reasons.push(`commit messages contain forbidden claim: ${claim}`);
  }
  if (existsSync(ctx.evidenceMd)) {
    reasons.push(...claimsSectionReasons(readFileSync(ctx.evidenceMd, "utf8")));
  }
  return reasons;
}

function validateShape(ctx: ShapeContext): string[] {
  const reasons: string[] = [];
  const evidence = rec(readJsonFile(ctx.evidenceJson));
  if (evidence === undefined) {
    reasons.push(`ENOENT or unparseable: ${ctx.evidenceJson}`);
    return reasons;
  }
  if (!existsSync(ctx.evidenceMd)) {
    reasons.push(`ENOENT: ${ctx.evidenceMd}`);
  }
  reasons.push(...shapeHeadSha(ctx, evidence));
  reasons.push(...shapeHonestyAndClaims(evidence));
  reasons.push(...shapeGates(evidence));
  reasons.push(...shapeBlockers(evidence));

  const measured = rec(readJsonFile(ctx.measurements));
  if (measured === undefined) {
    reasons.push("ENOENT: tmp/sharedlib6/measurements.json");
  } else {
    reasons.push(...shapeTarball(ctx, evidence, measured));
    reasons.push(...shapeConsumers(evidence, measured));
    reasons.push(...shapeParity(ctx, evidence, measured));
    reasons.push(...shapeVerdicts(ctx, evidence, measured));
  }
  reasons.push(...shapeMutations(ctx, evidence));
  reasons.push(...shapeSection2(ctx, evidence));
  reasons.push(...shapeCheckSteps(ctx, evidence));
  reasons.push(...shapeForbiddenClaims(ctx));
  return reasons;
}

const shapeReasons = validateShape(shapeCtx);
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
