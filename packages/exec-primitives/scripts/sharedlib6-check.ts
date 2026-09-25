/**
 * sharedlib6-check.ts — composite qualification check for the shared
 * execution-primitives candidate. Runs every gate in order, tees each gate's
 * output to tmp/sharedlib6-run/check-<gate>.log, and writes:
 *
 *   tmp/sharedlib6-run/check.json  — per-gate results + verdict
 *   tmp/sharedlib6-run/check.exit  — "0" or "1"
 *
 * Gate order matters: `consumers` (qualify.ts) packs and leaves the extracted
 * tarball under tmp/sharedlib6-run/extract-a for the `closure-audit-tarball`
 * gate that follows.
 *
 * Evidence-only: PASS means the gates are green in this tree; it asserts
 * nothing about release, publication, or adoption.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6-run");

interface Gate {
  name: string;
  cmd: string[];
  cwd: string;
}

const GATES: Gate[] = [
  {
    name: "build+typecheck",
    cmd: ["bun", "run", "build"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "contract-suite",
    cmd: ["bun", "test", "./test/"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "suite-tags",
    cmd: ["bun", "scripts/check-suite-tags.ts"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "closure-audit-src",
    cmd: ["bun", "scripts/closure-audit.ts", "--src", "--consumers"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "closure-audit-self-test",
    cmd: ["bun", "scripts/closure-audit.ts", "--self-test"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "mutations",
    cmd: ["bun", "scripts/run-mutations.ts", "--out", join(RUN_DIR, "mutations.json")],
    cwd: PACKAGE_DIR,
  },
  {
    name: "typecheck-coverage",
    cmd: ["bun", "scripts/check-typecheck-coverage.ts"],
    cwd: REPO_ROOT,
  },
  {
    name: "consumers",
    cmd: ["bun", "scripts/qualify.ts"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "closure-audit-tarball",
    cmd: ["bun", "scripts/closure-audit.ts", "--tarball", join(RUN_DIR, "extract-a")],
    cwd: PACKAGE_DIR,
  },
];

mkdirSync(RUN_DIR, { recursive: true });

let allOk = true;
const results: { gate: string; exit: number; log: string }[] = [];
for (const gate of GATES) {
  const result = spawnSync(gate.cmd[0] ?? "", gate.cmd.slice(1), {
    cwd: gate.cwd,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 600_000,
  });
  const exit = result.status ?? -1;
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(join(RUN_DIR, `check-${gate.name}.log`), log);
  results.push({ gate: gate.name, exit, log });
  if (exit !== 0) allOk = false;
  process.stdout.write(`gate ${gate.name}: exit=${String(exit)}\n`);
}

const summary = {
  gates: results.map((r) => {
    const pass = /(\d+) pass/.exec(r.log)?.[1];
    const fail = /(\d+) fail/.exec(r.log)?.[1];
    return { gate: r.gate, exit: r.exit, pass: pass ?? null, fail: fail ?? null };
  }),
  result: allOk ? "PASS" : "FAIL",
};
writeFileSync(join(RUN_DIR, "check.exit"), `${String(allOk ? 0 : 1)}\n`);
writeFileSync(join(RUN_DIR, "check.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`sharedlib6-check: ${allOk ? "PASS" : "FAIL"} (exit=${allOk ? "0" : "1"})\n`);
process.exit(allOk ? 0 : 1);
