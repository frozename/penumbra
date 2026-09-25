import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Composite qualification check for the shared execution-primitives candidate.
// Runs every gate in order and emits one line per gate plus a final verdict.
// Evidence-only: a PASS means the gates are green in this tree, nothing more.

const PACKAGE_DIR = dirname(import.meta.dir);
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
    cmd: ["bun", "test", "test/"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "closure-audit",
    cmd: ["bun", "scripts/closure-audit.ts", "--src"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "mutations",
    cmd: ["bun", "qualification/run-mutations.ts"],
    cwd: PACKAGE_DIR,
  },
  {
    name: "consumers",
    cmd: ["bun", "qualification/qualify.ts"],
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
