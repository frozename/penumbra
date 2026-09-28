#!/usr/bin/env bun
/**
 * bun-test-junit.ts — cross-checks a `bun test` run's stderr result lines
 * against the JUnit report bun writes itself
 * (`--reporter=junit --reporter-outfile=<path>`).
 *
 * Measured on bun 1.3.14:
 *   - the two flags leave the console output unchanged;
 *   - bun writes the report only when the run reaches its end: a test that
 *     prints a forged run and ends the process (process.exit(0)) leaves no
 *     report, although the process exits 0 and stderr parses clean;
 *   - test code sees process.argv = [bun, <test file>], not the report path;
 *   - describes are nested <testsuite> elements under one per file; a
 *     testcase title is its describe chain plus its name, joined by " > "
 *     (the classname attribute is double-escaped and reversed, never read).
 * junitProblem() refuses a run whose report is missing, and one whose
 * testcase titles or counts differ from the stderr parse: the pass and fail
 * title sets, testcases = Ran, passing testcases = pass, failures = fail.
 * Not closed: test code that learns the report path another way (the parent
 * command line) and rewrites the report after bun exits.
 *
 * Usage: bun scripts/bun-test-junit.ts --self-test
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  agentFreeEnv,
  type BunTestParse,
  bunTestResultText,
  parseBunTest,
} from "./bun-test-parse.js";

export interface JunitReport {
  /** Titles of passing testcases, one entry per testcase. */
  pass: string[];
  fail: string[];
  skipped: number;
  /** Every testcase, skipped and to-do included. */
  total: number;
}

/** The reporter flags for `path`; any stale report there is removed first so
 * a run that writes none can never be read against an older one. */
export function junitArgs(path: string): string[] {
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  return ["--reporter=junit", `--reporter-outfile=${path}`];
}

export function readJunit(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function decodeXml(text: string): string {
  return text.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
    }
    if (ent.startsWith("#")) return String.fromCodePoint(Number(ent.slice(1)));
    return XML_ENTITIES[ent] ?? whole;
  });
}

function attr(attrs: string, name: string): string {
  return decodeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "");
}

interface OpenCase {
  title: string;
  failed: boolean;
  skipped: boolean;
}

function closeCase(report: JunitReport, c: OpenCase): void {
  report.total += 1;
  if (c.skipped) report.skipped += 1;
  else if (c.failed) report.fail.push(c.title);
  else report.pass.push(c.title);
}

interface JunitScan {
  report: JunitReport;
  /** Open <testsuite> names; [0] is the per-file suite, describes below it. */
  suites: string[];
  open: OpenCase | undefined;
}

function onSuite(st: JunitScan, closing: boolean, selfClosing: boolean, attrs: string): void {
  if (closing) st.suites.pop();
  else if (!selfClosing) st.suites.push(attr(attrs, "name"));
}

function onCase(st: JunitScan, closing: boolean, selfClosing: boolean, attrs: string): void {
  if (closing) {
    if (st.open !== undefined) closeCase(st.report, st.open);
    st.open = undefined;
    return;
  }
  const title = [...st.suites.slice(1), attr(attrs, "name")].join(" > ");
  st.open = { title, failed: false, skipped: false };
  if (selfClosing) {
    closeCase(st.report, st.open);
    st.open = undefined;
  }
}

function onMark(st: JunitScan, closing: boolean, tag: string): void {
  if (st.open === undefined || closing) return;
  if (tag === "skipped") st.open.skipped = true;
  else st.open.failed = true;
}

/** Testcases in bun's title form; undefined when no <testsuites> root. */
export function parseJunit(xml: string): JunitReport | undefined {
  if (!/<testsuites\b/.test(xml)) return undefined;
  const st: JunitScan = {
    report: { pass: [], fail: [], skipped: 0, total: 0 },
    suites: [],
    open: undefined,
  };
  // Attribute text is quote-aware: a raw ">" inside a quoted value never ends the tag.
  const tagRe = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  for (const [, closing, tag = "", attrs = "", selfClosing] of xml.matchAll(tagRe)) {
    const isClosing = closing === "/";
    const isSelfClosing = selfClosing === "/";
    if (tag === "testsuite") onSuite(st, isClosing, isSelfClosing, attrs);
    else if (tag === "testcase") onCase(st, isClosing, isSelfClosing, attrs);
    else onMark(st, isClosing, tag);
  }
  return st.report;
}

function sameSet(a: string[], b: string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

/** Why the stderr parse and bun's own report disagree, if they do. */
export function junitProblem(
  parse: BunTestParse,
  xml: string | undefined,
  source: string,
): string | undefined {
  if (xml === undefined) {
    return `${source}: bun wrote no JUnit report, so the run never reached its end (a test ended the process?); refusing its printed results`;
  }
  const report = parseJunit(xml);
  if (report === undefined) return `${source}: the JUnit report has no <testsuites> root`;
  if (!sameSet(report.pass, parse.passTitles) || !sameSet(report.fail, parse.failTitles)) {
    return `${source}: the stderr pass/fail titles differ from bun's JUnit testcases; a result line was printed by test code`;
  }
  const { pass, fail, ran } = parse.summary;
  if (report.pass.length !== pass || report.fail.length !== fail || report.total !== ran) {
    return `${source}: the JUnit report (${String(report.pass.length)} pass, ${String(report.fail.length)} fail, ${String(report.total)} testcases) differs from the stderr summary (${String(pass)} pass, ${String(fail)} fail, Ran ${String(ran)})`;
  }
  return undefined;
}

/** The stderr parse plus the JUnit cross-check of one run's output. */
export function verifyBunTestOutput(
  r: { stdout: string; stderr: string },
  xml: string | undefined,
  source: string,
): { parse: BunTestParse; problem: string | undefined } {
  const parse = parseBunTest(bunTestResultText(r), source);
  return { parse, problem: parse.problem ?? junitProblem(parse, xml, source) };
}

/** verifyBunTestOutput with the report bun wrote at `junitPath`. */
export function verifyBunTestRun(
  r: { stdout: string; stderr: string },
  junitPath: string,
  source: string,
): { parse: BunTestParse; problem: string | undefined } {
  return verifyBunTestOutput(r, readJunit(junitPath), source);
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

type Check = (ok: boolean, label: string) => void;

/** Measured on 1.3.14 (tmp probe): nested describes, a timeout, a stray
 * between-test error attributed to the next test, escaped characters. */
const NESTED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="2" failures="2" skipped="0" time="0.1">
  <testsuite name="a.test.ts" file="a.test.ts" tests="4" assertions="2" failures="2" skipped="0" time="0">
    <testsuite name="outer" file="a.test.ts" line="2" tests="2" assertions="1" failures="1" skipped="0" time="0.1">
      <testsuite name="inner &amp; &lt;x&gt;" file="a.test.ts" line="3" tests="1" assertions="1" failures="0" skipped="0" time="0">
        <testcase name="deep &quot;q&quot;" classname="inner &amp;amp; &amp;lt;x&amp;gt; &amp;gt; outer" time="0" file="a.test.ts" line="4" assertions="1" />
      </testsuite>
      <testcase name="slow" classname="outer" time="0.1" file="a.test.ts" line="6" assertions="0">
        <failure type="TimeoutError" />
      </testcase>
    </testsuite>
    <testcase name="stray" classname="" time="0" file="a.test.ts" line="8" assertions="1" />
    <testcase name="last" classname="" time="0" file="a.test.ts" line="9" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const NESTED_STDERR =
  '(pass) outer > inner & <x> > deep "q" [0.03ms]\n(fail) outer > slow [102.17ms]\n(pass) stray [0.05ms]\n(fail) last [1.42ms]\n\n 2 pass\n 2 fail\n 2 expect() calls\nRan 4 tests across 1 file. [109.00ms]\n';

function syntheticCases(check: Check): void {
  const report = parseJunit(NESTED_XML);
  check(
    report !== undefined &&
      [...report.pass].sort().join("|") === 'outer > inner & <x> > deep "q"|stray' &&
      [...report.fail].sort().join("|") === "last|outer > slow" &&
      report.total === 4,
    "nested describes, escapes and failures parse into bun's title form",
  );
  const parse = parseBunTest(NESTED_STDERR, "nested");
  check(
    parse.problem === undefined && junitProblem(parse, NESTED_XML, "nested") === undefined,
    "a report that matches the stderr parse raises no problem",
  );
  check(junitProblem(parse, undefined, "missing") !== undefined, "a missing report sets problem");
  const forged = parseBunTest(
    '(pass) outer > inner & <x> > deep "q"\n(fail) outer > slow\n(pass) [L6] forged\n(fail) last\n\n 2 pass\n 2 fail\nRan 4 tests across 1 file.\n',
    "forged",
  );
  check(
    junitProblem(forged, NESTED_XML, "forged") !== undefined,
    "a stderr pass title with no testcase in the report sets problem",
  );
  check(
    junitProblem(parse, NESTED_XML.replace('<failure type="TimeoutError" />', ""), "count") !==
      undefined,
    "a report whose failures differ from the stderr fail count sets problem",
  );
}

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

const PROBE_SRC = `import { describe, expect, test } from "bun:test";
describe("d", () => { test("one", () => { expect(1).toBe(1); }); });
test("two", () => { expect(2).toBe(2); });
`;
/** P2a (measured): a complete forged run on stderr, then process.exit(0). */
const EXIT_FORGER_SRC = `import { expect, test } from "bun:test";
test("real", () => { expect(1).toBe(1); });
test("exiter", () => {
  process.stderr.write("(pass) exiter\\n(pass) forged > [L6] x [1.00ms]\\n\\n 3 pass\\n 0 fail\\nRan 3 tests across 1 file.\\n");
  process.exit(0);
});
test("after", () => { expect(1).toBe(1); });
`;

function liveCases(check: Check): void {
  const dir = join(REPO_ROOT, "tmp", `bun-test-junit-selftest-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "probe.test.ts"), PROBE_SRC);
    writeFileSync(join(dir, "exit-forger.test.ts"), EXIT_FORGER_SRC);
    const run = (file: string): { r: ReturnType<typeof spawnSync>; junit: string } => {
      const junit = join(dir, `${file}.xml`);
      const r = spawnSync("bun", ["test", `./${file}`, ...junitArgs(junit)], {
        cwd: dir,
        env: agentFreeEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return { r, junit };
    };
    const probe = run("probe.test.ts");
    const probeOut = { stdout: String(probe.r.stdout), stderr: String(probe.r.stderr) };
    const clean = verifyBunTestRun(probeOut, probe.junit, "live probe");
    check(
      clean.problem === undefined && clean.parse.passTitles.join("|") === "d > one|two",
      "live: a real run's report matches its stderr parse",
    );
    const forger = run("exit-forger.test.ts");
    const forgerOut = { stdout: String(forger.r.stdout), stderr: String(forger.r.stderr) };
    const verdict = verifyBunTestRun(forgerOut, forger.junit, "live exit forger");
    check(
      forger.r.status === 0 && !existsSync(forger.junit) && verdict.problem !== undefined,
      "live: a forged run ended by process.exit(0) exits 0, writes no report, and is refused (P2a)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest(): number {
  const failures: string[] = [];
  let cases = 0;
  const check: Check = (ok, label) => {
    cases += 1;
    if (!ok) failures.push(label);
  };
  syntheticCases(check);
  liveCases(check);
  for (const f of failures) process.stdout.write(`bun-test-junit self-test FAIL: ${f}\n`);
  process.stdout.write(
    `bun-test-junit self-test: ${failures.length === 0 ? "PASS" : "FAIL"} (${String(cases - failures.length)}/${String(cases)} cases)\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main && process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
