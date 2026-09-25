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
 *   3. fourteen ordered gates (below). Every gate runs even when an earlier
 *      one failed; one line per gate is printed.
 *   4. SHAPE — the committed evidence pair must be internally consistent and
 *      must match this run's fresh measurements field-for-field. Missing,
 *      malformed, stale, or inconsistent evidence is a failure.
 *   5. SHAREDLIB6-CHECK PASS, or SHAREDLIB6-CHECK FAIL listing every failing
 *      gate (plus SHAPE). There is no check.exit file; nothing downstream of
 *      a failed step is allowed to stand in for a real verdict.
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

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const LOG_DIR = join(RUN_DIR, "check-logs");
const KEEP = process.argv.includes("--keep");

const BASE_SHA = "c264644bc2b4f1e1429e845208fd6ca7f6426d62";
const REQUIRED_ANCESTORS = [
  BASE_SHA,
  "a338eb8e3",
  "e634f10db87e0f36a14338356e1887cfbf58c83d",
];
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

const FORBIDDEN_CLAIMS = [
  "qualified",
  "ready",
  "released",
  "channel chosen",
  "home chosen",
  "adopted by llamactl",
  "dual-consumer parity",
  "warm pooling is session resume",
];

function claimRe(claim: string): RegExp {
  return new RegExp(`\\b${claim.replaceAll(" ", "\\s+")}\\b`, "i");
}

interface CmdOut {
  exit: number;
  output: string;
}

function run(argv: string[], cwd: string, env?: NodeJS.ProcessEnv): CmdOut {
  const [bin, ...args] = argv;
  const r = spawnSync(bin, args, {
    cwd,
    env: env ?? { ...process.env },
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
// 3. ordered gates — all run; failures accumulate
// ---------------------------------------------------------------------------
interface GateRec {
  gate: string;
  exit: number;
  pass: number | null;
  fail: number | null;
  log: string;
  gating: boolean;
}

const gates: GateRec[] = [];

function recordGate(
  gate: string,
  outs: CmdOut[],
  logNames: string[],
  gating = true,
): void {
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
recordGate(
  "typecheck",
  [runLogged(["bun", "run", "typecheck"], R, "typecheck")],
  ["typecheck"],
);

// 2. dist freshness, strict
recordGate(
  "dist-freshness",
  [
    runLogged(["bun", "scripts/check-dist-freshness.ts"], R, "dist-freshness", {
      ...process.env,
      DIST_CHECK_STRICT: "1",
    }),
  ],
  ["dist-freshness"],
);

// 3. typecheck coverage — repo ratchet (exec-primitives floor: 0 errors) plus
// the package file-coverage gate (every .ts inside a compiled project)
recordGate(
  "typecheck-coverage",
  [
    runLogged(
      ["bun", "scripts/check-typecheck-coverage.ts"],
      R,
      "typecheck-coverage-ratchet",
    ),
    runLogged(
      ["bun", "scripts/check-typecheck-coverage.ts"],
      P,
      "typecheck-coverage-files",
    ),
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
      { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
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
    runLogged(
      ["bun", "scripts/bun-test-gate.ts", "packages/exec-primitives"],
      R,
      "bun-test-gate",
    ),
    runLogged(["bun", "scripts/check-suite-tags.ts"], P, "suite-tags"),
  ],
  ["bun-test-gate", "suite-tags"],
);

// 8. mutation loop
recordGate(
  "mutations",
  [
    runLogged(
      [
        "bun",
        "scripts/run-mutations.ts",
        "--out",
        join(RUN_DIR, "mutations.json"),
      ],
      P,
      "mutations",
    ),
  ],
  ["mutations"],
);

// 9. section-2 baseline slice (origin adapter suites + test/cli)
recordGate(
  "section2-slice",
  [
    runLogged(
      [
        "bun",
        "scripts/section2-slice.ts",
        "--out",
        join(RUN_DIR, "section2.json"),
      ],
      P,
      "section2-slice",
    ),
  ],
  ["section2-slice"],
);

// 10. fence — adapter sources untouched, nothing generated under qualification/
{
  const adapterDiff = git(["diff", "--stat", BASE_SHA, "HEAD", "--", "packages/agentchat/src/adapters"]);
  const qualStatus = git(["status", "--porcelain", "--", "packages/exec-primitives/qualification"]);
  const output = `adapter-diff:\n${adapterDiff.output}\nqualification-status:\n${qualStatus.output}`;
  writeFileSync(join(LOG_DIR, "check-fence.log"), output);
  const clean = adapterDiff.output.trim() === "" && qualStatus.output.trim() === "";
  recordGate("fence", [{ exit: clean ? 0 : 1, output }], ["fence"]);
}

// 11. closure audit on source + consumer fixtures
recordGate(
  "closure-audit-src",
  [
    runLogged(
      ["bun", "scripts/closure-audit.ts", "--src", "--consumers"],
      P,
      "closure-audit-src",
    ),
  ],
  ["closure-audit-src"],
);

// 12. tarball qualification (pack, copy, install, run, consumers.json)
recordGate(
  "qualify",
  [runLogged(["bun", "scripts/qualify.ts"], P, "qualify")],
  ["qualify"],
);

// 13. closure audit on the packed+extracted tarball
recordGate(
  "closure-audit-tarball",
  [
    runLogged(
      [
        "bun",
        "scripts/closure-audit.ts",
        "--tarball",
        join(RUN_DIR, "pack", "extracted"),
      ],
      P,
      "closure-audit-tarball",
    ),
  ],
  ["closure-audit-tarball"],
);

// 14. root lint — recorded, non-gating
recordGate(
  "root-lint",
  [runLogged(["bun", "run", "lint"], R, "root-lint")],
  ["root-lint"],
  false,
);

for (const [i, g] of gates.entries()) {
  const countsStr = g.pass === null ? "" : ` ${String(g.pass)}p/${String(g.fail ?? "?")}f`;
  const flag = g.gating ? "" : " (non-gating)";
  process.stdout.write(
    `step ${String(i + 1).padStart(2, "0")} ${g.gate}: exit=${String(g.exit)}${countsStr}${flag}\n`,
  );
}

// ---------------------------------------------------------------------------
// 4. SHAPE — committed evidence vs this run's measurements
// ---------------------------------------------------------------------------
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function validateShape(): string[] {
  const reasons: string[] = [];
  const evidence = readJsonFile(EVIDENCE_JSON) as Record<string, unknown> | undefined;
  if (evidence === undefined) {
    reasons.push(`ENOENT or unparseable: ${EVIDENCE_JSON}`);
    return reasons;
  }
  if (!existsSync(EVIDENCE_MD)) {
    reasons.push(`ENOENT: ${EVIDENCE_MD}`);
  }

  const head = git(["rev-parse", "HEAD"]).output.trim();
  if (evidence["base_sha"] !== BASE_SHA) reasons.push("evidence base_sha != required base");
  if (evidence["head_sha"] !== head) reasons.push("evidence head_sha != HEAD");

  const honesty = evidence["honesty"] as Record<string, unknown> | undefined;
  if (
    honesty === undefined ||
    honesty["channel_stand_in"] !== true ||
    honesty["overall_claim"] !== "none" ||
    honesty["channel_chosen"] !== false ||
    honesty["home_chosen"] !== false ||
    honesty["published"] !== false ||
    honesty["adopted"] !== false
  ) {
    reasons.push("honesty fields missing or wrong");
  }
  const claims = evidence["claims_not_made"];
  if (
    !Array.isArray(claims) ||
    claims.length !== FORBIDDEN_CLAIMS.length ||
    !FORBIDDEN_CLAIMS.every((c) => claims.includes(c))
  ) {
    reasons.push("claims_not_made does not list exactly the required claims");
  }

  const deviations = evidence["deviations"];
  if (
    !Array.isArray(deviations) ||
    deviations.some(
      (d) =>
        typeof d !== "object" ||
        d === null ||
        ["rule", "change", "reason", "pointer"].some(
          (k) => typeof (d as Record<string, unknown>)[k] !== "string" || (d as Record<string, unknown>)[k] === "",
        ),
    )
  ) {
    reasons.push("deviations[] entries must all carry non-empty rule/change/reason/pointer");
  }

  const consumersJson = readJsonFile(join(RUN_DIR, "consumers.json")) as
    | Record<string, unknown>
    | undefined;
  if (consumersJson === undefined) {
    reasons.push("ENOENT: tmp/sharedlib6/consumers.json");
  } else {
    const measuredTarball = consumersJson["tarball"] as Record<string, unknown> | undefined;
    const evTarball = evidence["tarball"] as Record<string, unknown> | undefined;
    if (measuredTarball === undefined || evTarball === undefined) {
      reasons.push("tarball block missing from evidence or measurements");
    } else {
      if (evTarball["channel"] !== "stand-in") reasons.push("tarball.channel != stand-in");
      for (const k of ["name", "sha256", "content_sha256", "files", "unpacked_bytes", "repack_identical"]) {
        if (!deepEqual(evTarball[k], measuredTarball[k])) {
          reasons.push(`tarball.${k} evidence != measurement`);
        }
      }
      if (measuredTarball["repack_identical"] !== true) {
        reasons.push("repack determinism not measured identical");
      }
    }
    const measuredConsumers = consumersJson["consumers"] as Record<string, unknown> | undefined;
    const evConsumers = evidence["consumers"] as Record<string, unknown> | undefined;
    if (measuredConsumers === undefined || evConsumers === undefined) {
      reasons.push("consumers block missing from evidence or measurements");
    } else {
      if (!deepEqual(evConsumers, measuredConsumers)) {
        reasons.push("consumers evidence != fresh measurements");
      } else {
        for (const [name, rec] of Object.entries(measuredConsumers)) {
          const r = rec as Record<string, unknown>;
          const spec = String(r["install_specifier"] ?? "");
          if (!/^\.\.?\/pack\/penumbra-exec-primitives-0\.1\.0\.tgz$/.test(spec)) {
            reasons.push(`${name}: install_specifier ${spec} does not name the tmp pack tarball`);
          }
          if (r["home_entries_after"] !== 0) {
            reasons.push(`${name}: isolated HOME not empty after run`);
          }
          if (r["network_required"] !== false) {
            reasons.push(`${name}: runtime steps did not prove network-free`);
          }
          if ((r["poison_run"] as Record<string, unknown> | undefined)?.["exit"] !== 0) {
            reasons.push(`${name}: poison run did not resolve to the stub`);
          }
          if (r["digest_equal"] !== true) {
            reasons.push(`${name}: installed content digest != tarball digest`);
          }
          const steps = r["steps"];
          if (!Array.isArray(steps) || steps.some((s) => (s as { exit: number }).exit !== 0)) {
            reasons.push(`${name}: a consumer step exited non-zero`);
          }
        }
      }
    }
  }

  const mutationsJson = readJsonFile(join(RUN_DIR, "mutations.json")) as
    | Record<string, unknown>
    | undefined;
  if (mutationsJson === undefined) {
    reasons.push("ENOENT: tmp/sharedlib6/mutations.json");
  } else {
    if (!deepEqual(evidence["mutations"], mutationsJson["mutations"])) {
      reasons.push("mutations[] evidence != mutation-loop results");
    }
    if (mutationsJson["clean_after"] !== true) {
      reasons.push("mutations left the tree dirty");
    }
  }

  const section2 = readJsonFile(join(RUN_DIR, "section2.json")) as
    | Record<string, unknown>
    | undefined;
  if (section2 === undefined) {
    reasons.push("ENOENT: tmp/sharedlib6/section2.json");
  } else {
    const evSection2 = evidence["section2"] as Record<string, unknown> | undefined;
    if (evSection2 === undefined || !deepEqual(evSection2["measurements"], section2)) {
      reasons.push("section2 measurements evidence != fresh slice");
    }
  }

  const evGates = evidence["gates"];
  if (!Array.isArray(evGates)) {
    reasons.push("evidence gates[] missing");
  } else {
    const simplify = (list: unknown[]): unknown[] =>
      list.map((g) => {
        const rec = g as Record<string, unknown>;
        return { exit: rec["exit"], fail: rec["fail"], gate: rec["gate"], pass: rec["pass"] };
      });
    if (!deepEqual(simplify(evGates), simplify(gates))) {
      reasons.push("evidence gates[] != this run's gate results");
    }
  }

  // forbidden claims: README, consumer manifests, commit messages, and the
  // evidence md outside its Claims-not-made section
  const readme = readFileSync(join(PACKAGE_DIR, "README.md"), "utf8");
  const manifestText = ["penumbra-host", "infra-host"]
    .map((n) =>
      readFileSync(
        join(PACKAGE_DIR, "qualification", "consumers", n, "package.json"),
        "utf8",
      ),
    )
    .join("\n");
  const gitLog = git(["log", `${BASE_SHA}..HEAD`, "--format=%B"]).output;
  for (const claim of FORBIDDEN_CLAIMS) {
    const re = claimRe(claim);
    if (re.test(readme)) reasons.push(`README contains forbidden claim: ${claim}`);
    if (re.test(manifestText)) reasons.push(`consumer manifest contains forbidden claim: ${claim}`);
    if (re.test(gitLog)) reasons.push(`commit messages contain forbidden claim: ${claim}`);
  }
  if (existsSync(EVIDENCE_MD)) {
    const md = readFileSync(EVIDENCE_MD, "utf8");
    const sectionRe = /## Claims not made\n([\s\S]*?)(?=\n## |\n?$)/;
    const section = sectionRe.exec(md)?.[1] ?? "";
    for (const claim of FORBIDDEN_CLAIMS) {
      if (!section.includes(claim)) {
        reasons.push(`claims section missing: ${claim}`);
      }
      const rest = md.replace(sectionRe, "");
      if (claimRe(claim).test(rest)) {
        reasons.push(`claim "${claim}" appears outside the Claims-not-made section`);
      }
    }
  }
  return reasons;
}

const shapeReasons = validateShape();
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
      gates,
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
