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
 *   - parseBunTest() fails closed: `problem` is set whenever the raw
 *     "(pass)" / "(fail)" line counts differ from the summary's pass / fail
 *     counts, in either direction. An under-count is hidden output; an
 *     over-count is a result line printed by test code (a forged title).
 *     A "(pass) " / "(fail) " token anywhere but at a line start is refused
 *     too: a forged line that ends in a partial line splices bun's next
 *     result line onto it, which would keep the counts equal.
 * bun writes its result lines and summary to stderr; console.log in a test
 * goes to stdout, so every spawner parses stderr alone (bunTestResultText).
 * Logs that hold both streams still fail closed through the over-count rule.
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
  /** Raw "(pass)" / "(fail)" line counts — each must equal its summary count. */
  passLines: number;
  failLines: number;
  summary: BunTestSummary;
  /** Set when the result lines cannot account for the summary. */
  problem: string | undefined;
}

/** "(pass) t [1ms]" plain, or "✓ t [1ms]" / "✗ t" under FORCE_COLOR once the
 * ANSI codes are stripped. Skipped-test lines ("(skip)", "»") never match. */
const RESULT_LINE_RE = /^(?:\((pass|fail)\)|(✓|✗)) (.+?)(?: \[[\d.]+m?s\])?$/;
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const PLAIN_TOKEN_RE = /\((?:pass|fail)\) /g;

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

function lineCountProblem(
  source: string,
  kind: "pass" | "fail",
  summaryCount: number | null,
  lines: number,
): string | undefined {
  if (summaryCount === null || lines === summaryCount) return undefined;
  if (lines < summaryCount) {
    return `${source}: bun summary reports ${String(summaryCount)} ${kind} but only ${String(lines)} (${kind}) lines were parsed; refusing a partial title count (${FORMAT_ENV_KEYS.join("/")} set?)`;
  }
  return `${source}: ${String(lines)} (${kind}) lines were parsed but bun summary reports ${String(summaryCount)} ${kind}; a result line was printed by test code, refusing a forged title count`;
}

function titleProblem(
  source: string,
  summary: BunTestSummary,
  counts: {
    passLines: number;
    failLines: number;
    titles: number;
    plainLines: number;
    plainTokens: number;
  },
): string | undefined {
  if ((summary.ran ?? 0) > 0 && counts.titles === 0) {
    return `${source}: bun reported Ran ${String(summary.ran)} tests but 0 result titles were parsed; an output-format env key (${FORMAT_ENV_KEYS.join("/")}) hides or reshapes them, refusing to count`;
  }
  if (counts.plainTokens !== counts.plainLines) {
    return `${source}: ${String(counts.plainTokens - counts.plainLines)} (pass)/(fail) token(s) sit inside a line rather than at its start; a result line was spliced by test code, refusing a forged title count`;
  }
  return (
    lineCountProblem(source, "pass", summary.pass, counts.passLines) ??
    lineCountProblem(source, "fail", summary.fail, counts.failLines)
  );
}

/** The text a spawned `bun test` result is parsed from: stderr alone, where
 * bun writes its result lines and summary (measured on 1.3.14). Text a test
 * prints with console.log goes to stdout and is never read as a result. */
export function bunTestResultText(r: { stdout: string; stderr: string }): string {
  return r.stderr;
}

export function parseBunTest(raw: string, source: string): BunTestParse {
  const output = stripAnsi(raw);
  const pass = new Set<string>();
  const fail = new Set<string>();
  let passLines = 0;
  let failLines = 0;
  let plainLines = 0;
  for (const line of output.split("\n")) {
    const m = RESULT_LINE_RE.exec(line.trimEnd());
    const title = m?.[3];
    if (title === undefined || title === "") continue;
    if (m?.[1] !== undefined) plainLines += 1;
    if (m?.[1] === "pass" || m?.[2] === "✓") {
      passLines += 1;
      pass.add(title);
    } else {
      failLines += 1;
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
    failLines,
    summary,
    problem: titleProblem(source, summary, {
      passLines,
      failLines,
      titles: titles.length,
      plainLines,
      plainTokens: output.match(PLAIN_TOKEN_RE)?.length ?? 0,
    }),
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

/** Each test prints a forged result line: to stdout via console.log, or to
 * stderr (bun's result stream) via process.stderr.write. */
const FORGE_STDOUT_SRC = `import { expect, test } from "bun:test";
test("real one", () => { console.log("(pass) forged > [L6] via stdout [1.00ms]"); expect(1).toBe(1); });
`;
const FORGE_STDERR_SRC = `import { expect, test } from "bun:test";
test("real two", () => { process.stderr.write("(pass) forged > [L6] via stderr [1.00ms]\\n"); expect(2).toBe(2); });
`;

/** The forged line ends in a partial line, so bun's own "(pass) real three"
 * line is spliced onto it and the pass-line count still equals the summary. */
const FORGE_SPLICE_SRC = `import { expect, test } from "bun:test";
test("real three", () => { process.stderr.write("(pass) forged > [L6] spliced [1.00ms]\\nX"); expect(3).toBe(3); });
test("real four", () => { expect(4).toBe(4); });
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
  const forgedPass = parseBunTest(
    "(pass) d > p1 [0.10ms]\n(pass) d > forged [L6] [1.00ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
    "f",
  );
  check(
    forgedPass.problem !== undefined,
    "a forged extra (pass) line (2 lines, 1 pass) sets problem",
  );
  const forgedFail = parseBunTest(
    "(pass) d > p1 [0.10ms]\n(fail) d > forged [1.00ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
    "g",
  );
  check(
    forgedFail.problem !== undefined,
    "a forged extra (fail) line (1 line, 0 fail) sets problem",
  );
  const spliced = parseBunTest(
    "(pass) d > forged [L6] [1.00ms]\nX(pass) d > p1 [0.10ms]\n(pass) d > p2\n\n 2 pass\n 0 fail\nRan 2 tests across 1 file.\n",
    "h",
  );
  check(
    spliced.problem !== undefined,
    "a forged line spliced onto a real result line (counts still equal) sets problem",
  );
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

function forgeCases(
  check: (ok: boolean, label: string) => void,
  spawnFile: (file: string) => { stdout: string; stderr: string },
): void {
  const viaStdout = spawnFile("forge-stdout.test.ts");
  const stdoutParse = parseBunTest(bunTestResultText(viaStdout), "live forge stdout");
  check(
    stdoutParse.problem === undefined &&
      stdoutParse.passTitles.join("|") === "real one" &&
      !stdoutParse.titles.some((t) => t.includes("forged")),
    "live: a forged (pass) line on test stdout never reaches the parsed result stream",
  );
  check(
    parseBunTest(`${viaStdout.stdout}${viaStdout.stderr}`, "live forge combined").problem !==
      undefined,
    "live: a combined stdout+stderr log with a forged (pass) line sets problem",
  );
  const viaStderr = spawnFile("forge-stderr.test.ts");
  check(
    parseBunTest(bunTestResultText(viaStderr), "live forge stderr").problem !== undefined,
    "live: a forged (pass) line written to stderr sets problem",
  );
  const viaSplice = spawnFile("forge-splice.test.ts");
  check(
    parseBunTest(bunTestResultText(viaSplice), "live forge splice").problem !== undefined,
    "live: a forged stderr line spliced onto bun's next result line sets problem",
  );
}

function liveCases(check: (ok: boolean, label: string) => void): void {
  const dir = join(REPO_ROOT, "tmp", `bun-test-parse-selftest-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "probe.test.ts"), PROBE_SRC);
    writeFileSync(join(dir, "forge-stdout.test.ts"), FORGE_STDOUT_SRC);
    writeFileSync(join(dir, "forge-stderr.test.ts"), FORGE_STDERR_SRC);
    writeFileSync(join(dir, "forge-splice.test.ts"), FORGE_SPLICE_SRC);
    const spawnRaw = (
      file: string,
      env: Record<string, string> | undefined,
    ): { stdout: string; stderr: string } => {
      const r = spawnSync("bun", ["test", `./${file}`], {
        cwd: dir,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return { stdout: r.stdout, stderr: r.stderr };
    };
    const spawnProbe = (env: Record<string, string> | undefined): BunTestParse =>
      parseBunTest(bunTestResultText(spawnRaw("probe.test.ts", env)), "live probe");
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
    forgeCases(check, (file) => spawnRaw(file, agentFreeEnv()));
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
