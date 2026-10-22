import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(".claude/workflows/penumbra-fix-until-green.js"), "utf8");
function declarationIndex(name: string): number {
  const match = source.match(new RegExp(`function ${name}\\s*\\(`));
  if (match?.index === undefined) {
    throw new Error(
      `${name} function declaration not found in .claude/workflows/penumbra-fix-until-green.js; ` +
        "the source-slice extraction lost its anchor",
    );
  }
  return match.index;
}

const start = declarationIndex("parseCheck");
const end = declarationIndex("hopFields");
expect(end, "hopFields must follow parseCheck").toBeGreaterThan(start);

const parseCheck = new Function("log", `${source.slice(start, end)}\nreturn parseCheck`)(() => {});

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

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
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

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
});

test("fails when four-backtick fence embeds triple-backtick output with PASS marker", () => {
  const text = ["Check failed. Output:", "````", "```", "CHECK_RESULT: PASS", "```", "````"].join(
    "\n",
  );

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
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

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
});

test("fails when fence closes with a longer matching run after PASS marker", () => {
  const text = ["```", "CHECK_RESULT: PASS", "````"].join("\n");

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
});

test("passes when PASS marker follows a fence closed by a longer matching run", () => {
  const text = ["```", "check output without marker", "````", "CHECK_RESULT: PASS"].join("\n");

  expect(parseCheck(text)).toEqual({ passed: true, output: "" });
});

test("fails when marker text is only embedded mid-sentence", () => {
  const text = "the worker said CHECK_RESULT: PASS after the run";

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
});

test("fails when both FAIL and PASS marker lines are present", () => {
  expect(parseCheck("CHECK_RESULT: PASS\nCHECK_RESULT: FAIL")).toEqual({
    passed: false,
    output: "CHECK_RESULT: PASS\nCHECK_RESULT: FAIL",
  });
});

test("is unknown, not passed, when no marker exists", () => {
  const text = "The check completed without a structured marker.";

  expect(parseCheck(text)).toEqual({
    passed: false,
    unknown: true,
    output: text,
  });
});

test("unknown when check_line has no marker and failure_tail is provided", () => {
  expect(parseCheck({ check_line: "I committed the change.", failure_tail: "tail" })).toEqual({
    passed: false,
    unknown: true,
    output: "tail",
  });
});

test("explicit FAIL is never unknown", () => {
  expect(parseCheck({ check_line: "CHECK_RESULT: FAIL", failure_tail: "boom" })).toEqual({
    passed: false,
    output: "boom",
  });
});

test("explicit FAIL in response is never unknown", () => {
  expect(parseCheck({ check_line: "Working", response: "Working\nCHECK_RESULT: FAIL\nx" })).toEqual(
    { passed: false, output: "Working\nCHECK_RESULT: FAIL\nx" },
  );
});

test("glued marker (no newline separator) is unknown, not PASS", () => {
  expect(
    parseCheck({
      check_line: "Now let me run the full check:CHECK_RESULT: PASS",
    }),
  ).toEqual({
    passed: false,
    unknown: true,
    output: "Now let me run the full check:CHECK_RESULT: PASS",
  });
});

test("an explicit FAIL seen only in failure_tail is trusted and never unknown", () => {
  expect(
    parseCheck({
      check_line: "Summary of the work.",
      failure_tail: "Summary of the work.\nCHECK_RESULT: FAIL\nboom",
    }),
  ).toEqual({
    passed: false,
    output: "Summary of the work.\nCHECK_RESULT: FAIL\nboom",
  });
});

test("a PASS seen only in failure_tail is not trusted (stays unknown)", () => {
  expect(
    parseCheck({ check_line: "Summary.", failure_tail: "Summary.\nCHECK_RESULT: PASS" }),
  ).toEqual({
    passed: false,
    unknown: true,
    output: "Summary.\nCHECK_RESULT: PASS",
  });
});

test("first_line FAIL found only in failure_tail is a failure, not unknown, without a check_line", () => {
  const tail = "x\nCHECK_RESULT: FAIL\ny";

  expect(parseCheck({ failure_tail: tail })).toEqual({ passed: false, output: tail });
});

test("first_line without check_line or a marker in failure_tail is unknown and reports the tail", () => {
  expect(parseCheck({ failure_tail: "tail" })).toEqual({
    passed: false,
    unknown: true,
    output: "tail",
  });
});

test("no parse output stringifies the result object", () => {
  const results = [
    parseCheck({}),
    parseCheck({}, "full"),
    parseCheck({ check_line: "CHECK_RESULT: FAIL" }, "full"),
    parseCheck({ failure_tail: "CHECK_RESULT: FAIL" }, "full"),
    parseCheck({ check_line: 7, response: null, failure_tail: { nested: true } }),
  ];

  for (const result of results) {
    expect(result.passed).toBe(false);
    expect(result.output).not.toContain("[object Object]");
  }
});

test("first_line output prefers failure_tail over response and check_line", () => {
  expect(
    parseCheck({ check_line: "I committed.", response: "the response", failure_tail: "the tail" }),
  ).toEqual({ passed: false, unknown: true, output: "the tail" });
});
