#!/usr/bin/env bun
/**
 * suite-titles.ts — the static test titles of a suite's comment-stripped
 * sources, and the rule that every executed title must come from one.
 *
 * An executed "describe > ... > test" title matches only when its last
 * segment matches a test( / it( / test.each(...)( title in the sources and
 * every earlier segment matches a describe( title there. A template-literal
 * hole (`${...}`) or a printf-style placeholder (%s %d %i %f %j %o %p %#)
 * matches any text. So a result line that test code printed, naming a title
 * with no test( call behind it (a forged "[L6] ..." line), is refused even
 * when a stream check would pass it.
 * Not closed: a test( call that is present in the source but never runs.
 *
 * Usage: bun scripts/suite-titles.ts --self-test
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./closure-audit-core.js";

/** A string literal body up to its closing quote; a backslash escape (\") is
 * part of the body, never its end. */
const LITERAL = String.raw`(["'\`])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;
export const TITLE_RE = new RegExp(String.raw`\b(?:test|it)\s*\(\s*${LITERAL}`, "g");
// test.each(<rows>)("title") — the rows argument may itself contain brackets.
export const EACH_TITLE_RE = new RegExp(
  String.raw`\b(?:test|it)\.each\s*\([\s\S]*?\)\s*\(\s*${LITERAL}`,
  "g",
);
export const DESCRIBE_RE = new RegExp(String.raw`\bdescribe\s*\(\s*${LITERAL}`, "g");

export interface Title {
  index: number;
  text: string;
  /** A test.each title: printf-style placeholders are filled per row. */
  each: boolean;
}

export function titlesOf(src: string): Title[] {
  const plain = [...src.matchAll(TITLE_RE)].map((m) => ({
    index: m.index,
    text: m[2] ?? "",
    each: false,
  }));
  const each = [...src.matchAll(EACH_TITLE_RE)].map((m) => ({
    index: m.index,
    text: m[2] ?? "",
    each: true,
  }));
  return [...plain, ...each].sort((a, b) => a.index - b.index);
}

export function describeTitlesOf(src: string): Title[] {
  return [...src.matchAll(DESCRIBE_RE)].map((m) => ({
    index: m.index,
    text: m[2] ?? "",
    each: false,
  }));
}

const TEMPLATE_HOLE_RE = /\$\{[^}]*\}/g;
const EACH_HOLE_RE = /\$\{[^}]*\}|%[sdifjop#]/g;

/** A whole-title pattern: literal text, each hole matching any text. */
function titlePattern(t: Title): RegExp {
  const literal = t.text.replaceAll(/\\(["'`\\])/g, "$1");
  const parts = literal.split(t.each ? EACH_HOLE_RE : TEMPLATE_HOLE_RE);
  const esc = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${parts.map(esc).join("[\\s\\S]*?")}$`);
}

/** Comment-stripped sources of every *.test.ts under `dir`, recursively. */
export function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testSources(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(stripComments(readFileSync(full, "utf8")));
    }
  }
  return out;
}

/** Executed titles that no static test( title (with its describes) matches. */
export function unmatchedTitles(executed: string[], sources: string[]): string[] {
  const tests = sources.flatMap(titlesOf).map(titlePattern);
  const describes = sources.flatMap(describeTitlesOf).map(titlePattern);
  return executed.filter((title) => {
    const segs = title.split(" > ");
    const leaf = segs.pop() ?? "";
    const leafOk = tests.some((re) => re.test(leaf));
    return !leafOk || !segs.every((s) => describes.some((re) => re.test(s)));
  });
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

const SAMPLE_SRC = `import { describe, test } from "bun:test";
describe("[B10] single-owner guarantees", () => {
  test("[B10] the package namespace contains exactly the documented exports", () => {});
  // test("[L6] a commented-out test", () => {});
  const note = "(pass) [B10] single-owner guarantees > [L6] two imports";
});
describe("[B4] cancel grace", () => {
  for (const ms of [300, 2500] as const) {
    test(\`[B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=\${String(ms)}\`, async () => {});
  }
});
test.each([[1], [2]])("[B8] row %d frames", () => {});
test("[B10] top level \\"quoted\\" title", () => {});
`;

function selfTest(): number {
  const sources = [stripComments(SAMPLE_SRC)];
  const cases: [string[], string[], string][] = [
    [
      [
        "[B10] single-owner guarantees > [B10] the package namespace contains exactly the documented exports",
        "[B4] cancel grace > [B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=300",
        "[B8] row 1 frames",
        '[B10] top level "quoted" title',
      ],
      [],
      "real titles, a template hole, a test.each placeholder and an escaped quote match",
    ],
    [
      ["[B10] single-owner guarantees > [L6] two imports"],
      ["[B10] single-owner guarantees > [L6] two imports"],
      "a printed title with no test( call behind it is refused (p14d)",
    ],
    [
      ["[B10] single-owner guarantees > [L6] a commented-out test"],
      ["[B10] single-owner guarantees > [L6] a commented-out test"],
      "a commented-out test( title is refused",
    ],
    [
      [
        "[X] invented describe > [B10] the package namespace contains exactly the documented exports",
      ],
      [
        "[X] invented describe > [B10] the package namespace contains exactly the documented exports",
      ],
      "a real test title under an invented describe is refused",
    ],
  ];
  const failures = cases
    .filter(([executed, want]) => {
      const got = unmatchedTitles(executed, sources);
      return JSON.stringify(got) !== JSON.stringify(want);
    })
    .map(([, , label]) => label);
  for (const f of failures) process.stdout.write(`suite-titles self-test FAIL: ${f}\n`);
  process.stdout.write(
    `suite-titles self-test: ${failures.length === 0 ? "PASS" : "FAIL"} (${String(cases.length - failures.length)}/${String(cases.length)} cases)\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main && process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
