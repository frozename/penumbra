import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { isKnownBunTeardownPanicPass, parseBunTestReport } from "@src/worker/bun-test-output.js";

const TEARDOWN_PANIC = "panic(main thread): A C++ exception occurred\nBun has crashed\n";

const COUNT_LIKE_TITLES = `(pass) fanout > retries only nested supported HTTP 503 error codes [0.62ms]
(pass) gate > reports 3 fail when the shard exits 1 [0.40ms]
(pass) gate > reports 2 pass for a green shard [0.31ms]
`;

const PASSING_SUMMARY = `
 5 pass
 0 fail
 5 expect() calls
Ran 5 tests across 1 file. [19.00ms]
`;

function counts(output: string): { pass: number | null; fails: number | null; errors: number } {
  const { pass, fails, errors } = parseBunTestReport(output);
  return { pass, fails, errors };
}

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/bun-test-output/${name}.txt`, import.meta.url), "utf8");
}

test.each([
  ["before", `scripts/gate.test.ts:\n${COUNT_LIKE_TITLES}${PASSING_SUMMARY}`],
  ["after", `scripts/gate.test.ts:\n${PASSING_SUMMARY}${COUNT_LIKE_TITLES}`],
])(
  "count-like text in passing test titles %s the summary does not change the counts",
  (_, output) => {
    expect(counts(output)).toEqual({ pass: 5, fails: 0, errors: 0 });
  },
);

test("reads a pluralised errors summary line", () => {
  const output = " 0 pass\n 2 fail\n 2 errors\nRan 2 tests across 2 files. [9.00ms]\n";

  expect(counts(output)).toEqual({ pass: 0, fails: 2, errors: 2 });
});

test("reads a singular error summary line", () => {
  const output = " 1 pass\n 1 fail\n 1 error\nRan 2 tests across 2 files. [9.00ms]\n";

  expect(counts(output)).toEqual({ pass: 1, fails: 1, errors: 1 });
});

test("a passing shard mentioning a 503 error still counts as a known teardown panic pass", () => {
  const report = parseBunTestReport(
    `scripts/gate.test.ts:\n${COUNT_LIKE_TITLES}${PASSING_SUMMARY}${TEARDOWN_PANIC}`,
  );

  expect(isKnownBunTeardownPanicPass(report)).toBe(true);
});

test("a passing shard mentioning a 503 error has no failure keys", () => {
  const report = parseBunTestReport(
    `scripts/gate.test.ts:\n${COUNT_LIKE_TITLES}${PASSING_SUMMARY}`,
  );

  expect(report.failureKeys).toEqual([]);
});

test.each([
  ["all-pass", { pass: 2, fails: 0, errors: 0 }],
  ["one-fail", { pass: 1, fails: 1, errors: 0 }],
  ["two-fails", { pass: 1, fails: 2, errors: 0 }],
  ["one-error", { pass: 1, fails: 1, errors: 1 }],
  ["two-errors", { pass: 1, fails: 2, errors: 2 }],
  ["skip-todo", { pass: 1, fails: 0, errors: 0 }],
])("reads the counts from a captured bun %s summary", (name, expected) => {
  const report = parseBunTestReport(fixture(name));

  expect(report.reachedSummary).toBe(true);
  expect({ pass: report.pass, fails: report.fails, errors: report.errors }).toEqual(expected);
});

test.each(["one-error", "two-errors"])(
  "a captured %s load failure, which bun counts as both a fail and an error, adds no fallback key",
  (name) => {
    const report = parseBunTestReport(fixture(name));

    expect(report.failureKeys.some((key) => key.startsWith("unparsed:"))).toBe(false);
  },
);

test("fails that neither a (fail) line nor an error accounts for still add a fallback key", () => {
  const output =
    "scripts/gate.test.ts:\n(fail) gate > listed [0.40ms]\n\n 0 pass\n 3 fail\nRan 3 tests across 1 file. [9.00ms]\n";

  const report = parseBunTestReport(output);

  expect(report.failureKeys.some((key) => key.startsWith("unparsed:"))).toBe(true);
});
