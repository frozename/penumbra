import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(".claude/workflows/penumbra-fix-until-green.js"), "utf8");
const start = source.indexOf("function parseCheck(result)");
expect(start, "parseCheck should exist").toBeGreaterThanOrEqual(0);
const end = source.indexOf("function hopFields(result)", start);
expect(end, "hopFields should follow parseCheck").toBeGreaterThan(start);

const parseCheck = new Function(`${source.slice(start, end)}\nreturn parseCheck`)();

test("passes when PASS marker is on the first line", () => {
  expect(parseCheck("CHECK_RESULT: PASS\nAll good")).toEqual({ passed: true, output: "" });
});

test("passes when PASS marker appears after a narrative opener", () => {
  expect(parseCheck("Using systematic-debugging to verify the fix.\nCHECK_RESULT: PASS")).toEqual({
    passed: true,
    output: "",
  });
});

test("fails when an unfenced PASS marker is indented as a CommonMark code block", () => {
  const text = "Check failed, output follows:\n    CHECK_RESULT: PASS";

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("passes when PASS marker has exactly three leading spaces", () => {
  expect(parseCheck("   CHECK_RESULT: PASS")).toEqual({ passed: true, output: "" });
});

test("fails when four-space PASS and real FAIL marker lines are both present", () => {
  const text = "    CHECK_RESULT: PASS\nCHECK_RESULT: FAIL";

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("fails when fenced PASS is followed by a real FAIL marker", () => {
  expect(
    parseCheck(
      [
        "```",
        "Instructions included CHECK_RESULT: PASS here.",
        "CHECK_RESULT: PASS",
        "```",
        "CHECK_RESULT: FAIL",
      ].join("\n"),
    ),
  ).toEqual({
    passed: false,
    output: [
      "```",
      "Instructions included CHECK_RESULT: PASS here.",
      "CHECK_RESULT: PASS",
      "```",
      "CHECK_RESULT: FAIL",
    ].join("\n"),
  });
});

test("fails when tilde fence contains PASS marker", () => {
  const text = ["Check failed; output follows:", "~~~", "CHECK_RESULT: PASS", "~~~"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("fails when four-backtick fence embeds triple-backtick output with PASS marker", () => {
  const text = ["Check failed. Output:", "````", "```", "CHECK_RESULT: PASS", "```", "````"].join(
    "\n",
  );

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("fails when tilde-fenced PASS is followed by real FAIL marker", () => {
  const text = ["~~~", "CHECK_RESULT: PASS", "~~~", "CHECK_RESULT: FAIL"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("passes when PASS marker precedes an unterminated fence", () => {
  const text = ["CHECK_RESULT: PASS", "```", "check output starts here"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: true, output: "" });
});

test("fails when longer backtick fence contains shorter backtick fence and PASS marker", () => {
  const text = ["````", "```", "CHECK_RESULT: PASS", "```", "````"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("fails when fence closes with a longer matching run after PASS marker", () => {
  const text = ["```", "CHECK_RESULT: PASS", "````"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("passes when PASS marker follows a fence closed by a longer matching run", () => {
  const text = ["```", "check output without marker", "````", "CHECK_RESULT: PASS"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: true, output: "" });
});

test("fails when marker text is only embedded mid-sentence", () => {
  const text = "the worker said CHECK_RESULT: PASS after the run";

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});

test("fails when both FAIL and PASS marker lines are present", () => {
  expect(parseCheck("CHECK_RESULT: PASS\nCHECK_RESULT: FAIL")).toEqual({
    passed: false,
    output: "CHECK_RESULT: PASS\nCHECK_RESULT: FAIL",
  });
});

test("fails when no marker exists", () => {
  const text = "The check completed without a structured marker.";

  expect(parseCheck(text)).toEqual({ passed: false, output: text });
});
