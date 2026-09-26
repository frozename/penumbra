#!/usr/bin/env bun
/**
 * bun-test-parse.ts — the one env builder and the one output parser for every
 * `bun test` the qualification scripts spawn or read back.
 *
 * Traps (measured on bun 1.3.14): with CLAUDECODE, AGENT or REPL_ID set, `bun
 * test` prints no "(pass) <title>" lines; the summary, the exit code and the
 * "(fail)" lines are unchanged. With FORCE_COLOR set (NO_COLOR does not
 * override it) every result line becomes an ANSI "✓ <title>" / "✗ <title>"
 * line and the summary lines carry ANSI codes. Every title-derived gate (suite
 * tags, section-2 titles, parity coverage, tag passes) would then count
 * nothing, or count only the failures. Three guards:
 *   - agentFreeEnv() is the env for every spawned bun test: the parent env
 *     with the format keys removed, NO_COLOR=1, plus only the caller's extras;
 *   - parseBunTest() and bunTestSummary() strip ANSI codes and read the glyph
 *     form too;
 *   - parseBunTest() fails closed: `problem` is set whenever the summary
 *     reports tests that the result lines do not account for.
 *
 * Usage: bun scripts/bun-test-parse.ts --self-test
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AGENT_MODE_ENV_KEYS: readonly string[] = ["CLAUDECODE", "AGENT", "REPL_ID"];
/** Every key that changes bun test's result-line format (measured on 1.3.14:
 * FORCE_COLOR=1 replaces "(pass) t" with an ANSI "✓ t" line and wins over
 * NO_COLOR; CLICOLOR_FORCE, CI, GITHUB_ACTIONS and TERM leave it unchanged). */
export const FORMAT_ENV_KEYS: readonly string[] = [...AGENT_MODE_ENV_KEYS, "FORCE_COLOR"];

/** The parent env minus the format keys, NO_COLOR=1, plus `extra`. */
export function agentFreeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !FORMAT_ENV_KEYS.includes(key)) env[key] = value;
  }
  return { ...env, NO_COLOR: "1", ...extra };
}

export interface BunTestSummary {
  pass: number | null;
  fail: number | null;
  ran: number | null;
}

export interface BunTestParse {
  /** Distinct executed titles ("describe > test"), sorted. */
  titles: string[];
  passTitles: string[];
  failTitles: string[];
  /** Raw "(pass)" line count — compared against the summary's pass count. */
  passLines: number;
  summary: BunTestSummary;
  /** Set when the result lines cannot account for the summary. */
  problem: string | undefined;
}

/** "(pass) t [1ms]" plain, or "✓ t [1ms]" / "✗ t" under FORCE_COLOR once the
 * ANSI codes are stripped. Skipped-test lines ("(skip)", "»") never match. */
const RESULT_LINE_RE = /^(?:\((pass|fail)\)|(✓|✗)) (.+?)(?: \[[\d.]+m?s\])?$/;
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Output with every ANSI SGR sequence removed. */
export function stripAnsi(output: string): string {
  return output.replaceAll(ANSI_RE, "");
}

function summaryCount(output: string, re: RegExp): number | null {
  const m = re.exec(output)?.[1];
  return m === undefined ? null : Number(m);
}

export function bunTestSummary(raw: string): BunTestSummary {
  const output = stripAnsi(raw);
  return {
    pass: summaryCount(output, /^\s*(\d+) pass$/m),
    fail: summaryCount(output, /^\s*(\d+) fail$/m),
    ran: summaryCount(output, /^\s*Ran (\d+) tests?\b/m),
  };
}

function titleProblem(
  source: string,
  summary: BunTestSummary,
  passLines: number,
  titleCount: number,
): string | undefined {
  const keys = FORMAT_ENV_KEYS.join("/");
  if ((summary.ran ?? 0) > 0 && titleCount === 0) {
    return `${source}: bun reported Ran ${String(summary.ran)} tests but 0 result titles were parsed; an output-format env key (${keys}) hides or reshapes them, refusing to count`;
  }
  if (summary.pass !== null && passLines < summary.pass) {
    return `${source}: bun summary reports ${String(summary.pass)} pass but only ${String(passLines)} pass lines were parsed; refusing a partial title count (${keys} set?)`;
  }
  return undefined;
}

export function parseBunTest(raw: string, source: string): BunTestParse {
  const output = stripAnsi(raw);
  const pass = new Set<string>();
  const fail = new Set<string>();
  let passLines = 0;
  for (const line of output.split("\n")) {
    const m = RESULT_LINE_RE.exec(line.trimEnd());
    const title = m?.[3];
    if (title === undefined || title === "") continue;
    if (m?.[1] === "pass" || m?.[2] === "✓") {
      passLines += 1;
      pass.add(title);
    } else {
      fail.add(title);
    }
  }
  const summary = bunTestSummary(output);
  const titles = [...new Set([...pass, ...fail])].sort();
  return {
    titles,
    passTitles: [...pass].sort(),
    failTitles: [...fail].sort(),
    passLines,
    summary,
    problem: titleProblem(source, summary, passLines, titles.length),
  };
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

const PROBE_SRC = `import { expect, test } from "bun:test";
test("probe one", () => { expect(1).toBe(1); });
test("probe two", () => { expect(2).toBe(2); });
`;

function parserCases(check: (ok: boolean, label: string) => void): void {
  const agent = parseBunTest("\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n", "a");
  check(agent.problem !== undefined, "summary Ran 3 with no result lines sets problem");
  const allFail = parseBunTest("\n 0 pass\n 2 fail\nRan 2 tests across 1 file.\n", "a2");
  check(allFail.problem !== undefined, "summary Ran 2 (0 pass) with no result lines sets problem");
  const partial = parseBunTest(
    "(fail) d > f1 [0.10ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file.\n",
    "b",
  );
  check(partial.problem !== undefined, "fail lines only, 2 pass hidden, sets problem");
  const full = parseBunTest(
    "(pass) d > p1 [0.10ms]\n(pass) d > p2\n(fail) d > f1 [0.20ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file.\n",
    "c",
  );
  check(
    full.problem === undefined && full.titles.join("|") === "d > f1|d > p1|d > p2",
    "complete output parses three titles with no problem",
  );
  const single = parseBunTest(
    "(pass) only [1ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
    "d",
  );
  check(single.problem === undefined && single.summary.ran === 1, "singular 'Ran 1 test' parses");
  const esc = "\u001b";
  const colored = parseBunTest(
    `${esc}[0m${esc}[32m✓${esc}[0m${esc}[0m${esc}[1m d > p1${esc}[0m ${esc}[0m${esc}[2m[0.03ms${esc}[0m${esc}[2m]${esc}[0m\n` +
      `${esc}[0m${esc}[31m✗${esc}[0m${esc}[0m${esc}[1m d > f1${esc}[0m\n` +
      `${esc}[0m${esc}[33m»${esc}[2m${esc}[0m${esc}[2m d > s1${esc}[0m\n\n` +
      `${esc}[0m${esc}[32m 1 pass${esc}[0m\n ${esc}[0m${esc}[2m1 skip${esc}[0m\n${esc}[0m${esc}[31m 1 fail${esc}[0m\nRan 3 tests across 1 file.\n`,
    "e",
  );
  check(
    colored.problem === undefined &&
      colored.passTitles.join("|") === "d > p1" &&
      colored.failTitles.join("|") === "d > f1" &&
      colored.summary.pass === 1 &&
      colored.summary.fail === 1,
    "FORCE_COLOR glyph output (ANSI, ✓/✗) parses its titles and summary",
  );
}

function envCase(check: (ok: boolean, label: string) => void): void {
  // Named literally, not via FORMAT_ENV_KEYS, so shrinking that list fails here.
  for (const key of ["CLAUDECODE", "AGENT", "REPL_ID", "FORCE_COLOR"]) process.env[key] = "1";
  delete process.env["NO_COLOR"];
  const env = agentFreeEnv({ QUALIFY_EXTRA: "x" });
  check(
    ["CLAUDECODE", "AGENT", "REPL_ID", "FORCE_COLOR"].every((k) => !(k in env)) &&
      env["NO_COLOR"] === "1" &&
      env["QUALIFY_EXTRA"] === "x" &&
      env["PATH"] === process.env["PATH"],
    "agentFreeEnv drops CLAUDECODE/AGENT/REPL_ID/FORCE_COLOR, sets NO_COLOR, keeps PATH, adds extras",
  );
}

function liveCases(check: (ok: boolean, label: string) => void): void {
  const dir = join(REPO_ROOT, "tmp", `bun-test-parse-selftest-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "probe.test.ts"), PROBE_SRC);
    const spawnProbe = (env: Record<string, string> | undefined): BunTestParse => {
      const r = spawnSync("bun", ["test", "./probe.test.ts"], {
        cwd: dir,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return parseBunTest(`${r.stdout}${r.stderr}`, "live probe");
    };
    // envCase() set the agent keys and FORCE_COLOR on process.env: the
    // inherited env reproduces agent mode plus forced color, agentFreeEnv()
    // must not.
    const clean = spawnProbe(agentFreeEnv());
    check(
      clean.problem === undefined && clean.passTitles.length === 2 && clean.summary.pass === 2,
      "live bun test under agentFreeEnv() with FORCE_COLOR=1 in the parent yields both (pass) titles",
    );
    const colored = spawnProbe(
      Object.fromEntries(
        Object.entries(agentFreeEnv({ FORCE_COLOR: "1" })).filter(([k]) => k !== "NO_COLOR"),
      ),
    );
    check(
      colored.problem === undefined && colored.passTitles.length === 2,
      "live bun test under FORCE_COLOR=1 parses both glyph-form pass titles",
    );
    const inherited = spawnProbe(undefined);
    check(
      inherited.problem !== undefined || inherited.passLines === inherited.summary.pass,
      "live bun test under the agent env is refused or fully counted, never undercounted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest(): number {
  const failures: string[] = [];
  let cases = 0;
  const check = (ok: boolean, label: string): void => {
    cases += 1;
    if (!ok) failures.push(label);
  };
  parserCases(check);
  envCase(check);
  liveCases(check);
  for (const f of failures) process.stdout.write(`bun-test-parse self-test FAIL: ${f}\n`);
  process.stdout.write(
    `bun-test-parse self-test: ${failures.length === 0 ? "PASS" : "FAIL"} (${String(cases - failures.length)}/${String(cases)} cases)\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main && process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
